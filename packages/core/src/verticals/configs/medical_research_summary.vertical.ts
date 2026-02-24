import { createGuardrails } from '../guardrails';
import { defineVertical } from '../types';
import {
  buildResultMetadata,
  hasProvidedValue,
  normalizeConfidence,
  normalizeEvidenceQuotes,
  normalizeStructuredRecommendations,
  normalizeStructuredRisks,
  NOT_PROVIDED,
  toExecutiveSummaryArray,
  toNonEmptyString,
  toStringArray,
  uniqueStrings
} from './_expert_analysis.shared';
import { medicalResearchSummarySchema, type MedicalResearchSummaryResult } from './medical_research_summary.schema';

const MEDICAL_DISCLAIMER = 'This is an AI analysis of research evidence and not medical advice.';
const MEDICAL_SYSTEM_PROMPT = `You are a PhD-level biomedical researcher and evidence-based medical writer. Summarize and critique ONLY the provided research text.
Do not fabricate sample sizes, effect sizes, p-values, outcomes, or conclusions not explicitly present.

SAFETY / SCOPE
- This is research interpretation, not medical advice.
- Do not provide diagnosis or treatment recommendations.

EVIDENCE RULE
- Any stated finding must be supported by an exact quote from the input. If missing, mark as “Not provided” and record in missingInfo.

OUTPUT FORMAT (MANDATORY)
Return ONLY valid JSON matching this structure exactly (no markdown, no extra keys, no commentary):
{
  "executiveSummary": ["..."],
  "evidenceQuotes": [{"quote":"...","relevance":"..."}],
  "risks": [{"title":"...","severity":"high|medium|low","evidenceQuote":"...","impact":"...","mitigation":"..."}],
  "recommendations": [{"action":"...","rationale":"...","priority":"high|medium|low"}],
  "missingInfo": ["..."],
  "confidence": {"overall":"high|medium|low","reasons":["..."]},
  "metadata": {"useCaseKey":"medical_research_summary","provider":"Not provided","model":"Not provided","createdAt":"ISO-8601"}
}

QUALITY BAR
- executiveSummary: what was studied, main outcome(s), confidence.
- evidenceQuotes: 3–12 quotes from abstract/methods/results/limitations if available.
- risks: interpret as “methodological risks / bias / generalizability limits / safety reporting gaps”.
- recommendations: research-next-steps only (replication, data needed, better design). No clinical instructions.
- missingInfo: explicitly list missing methods, sample size, endpoints, statistics, conflicts of interest, etc.

If the input lacks methods/results, set confidence low and list what’s missing.`;

const preferProvided = (primary: unknown, fallback: unknown): string => {
  const primaryValue = toNonEmptyString(primary, NOT_PROVIDED);
  if (primaryValue !== NOT_PROVIDED) return primaryValue;
  return toNonEmptyString(fallback, NOT_PROVIDED);
};

const normalizeMedicalOutput = (output: MedicalResearchSummaryResult): MedicalResearchSummaryResult => {
  const legacySummary = preferProvided(output.executive_summary, output.evidence_summary);
  const executiveSummary =
    Array.isArray(output.executiveSummary) &&
    output.executiveSummary.length > 0 &&
    !(output.executiveSummary.length === 1 && output.executiveSummary[0] === NOT_PROVIDED)
      ? output.executiveSummary
      : toExecutiveSummaryArray(undefined, legacySummary);
  const evidenceQuotes = normalizeEvidenceQuotes(output.evidenceQuotes ?? output.evidence_quotes);
  const limitations = toStringArray(output.limitations);
  const safetyNotes = toStringArray(output.safety_notes);

  const derivedLegacyRisks = [
    ...limitations.map((text) => ({
      title: 'Methodological limitation',
      severity: 'medium' as const,
      evidenceQuote: NOT_PROVIDED,
      impact: text,
      mitigation: 'Request additional methodological detail or replication evidence.'
    })),
    ...safetyNotes.map((text) => ({
      title: 'Safety concern',
      severity: 'high' as const,
      evidenceQuote: NOT_PROVIDED,
      impact: text,
      mitigation: 'Escalate to qualified clinicians/researchers for review before any action.'
    }))
  ];
  const risks = normalizeStructuredRisks(output.risks).length > 0 ? normalizeStructuredRisks(output.risks) : derivedLegacyRisks;

  let recommendations = normalizeStructuredRecommendations(output.recommendations);
  if (recommendations.length === 0) {
    recommendations = [
      {
        action: 'Validate the source paper and supplementary materials before operational use.',
        rationale: 'No structured recommendations were returned.',
        priority: 'high'
      }
    ];
  }

  const researchQuestion = preferProvided(output.researchQuestion, output.research_question);
  const studyDesign = preferProvided(output.studyDesign, output.study_design);
  const sampleSize = preferProvided(output.sampleSize, output.sample_size);
  const primaryEndpoint = preferProvided(output.primaryEndpoint, output.primary_endpoint);
  const effectSizeSummary = preferProvided(output.effectSizeSummary, output.effect_size_summary);

  let missingInfo = uniqueStrings([...toStringArray(output.missingInfo), ...toStringArray(output.missing_info)]);
  if (!hasProvidedValue(studyDesign)) missingInfo.push('studyDesign');
  if (!hasProvidedValue(sampleSize)) missingInfo.push('sampleSize');
  if (!hasProvidedValue(primaryEndpoint)) missingInfo.push('primaryEndpoint');
  if (!hasProvidedValue(effectSizeSummary)) missingInfo.push('effectSizeSummary');
  if (evidenceQuotes.length === 0) missingInfo.push('evidenceQuotes');
  missingInfo = uniqueStrings(missingInfo);

  const metadataInput = output.metadata;
  const metadata = buildResultMetadata('medical_research_summary', {
    provider: metadataInput?.provider,
    model: metadataInput?.model,
    createdAt: metadataInput?.createdAt
  });

  return {
    ...output,
    executiveSummary,
    evidenceQuotes,
    risks,
    recommendations,
    missingInfo,
    confidence: normalizeConfidence(output.confidence),
    metadata,
    researchQuestion,
    studyDesign,
    sampleSize,
    primaryEndpoint,
    effectSizeSummary,
    executive_summary: executiveSummary.join(' ') || NOT_PROVIDED,
    research_question: researchQuestion,
    evidence_summary: toNonEmptyString(output.evidence_summary, executiveSummary.join(' ') || NOT_PROVIDED),
    evidence_quotes: evidenceQuotes.map((quote) => ({ ...quote, source_ref: 'input' })),
    missing_info: missingInfo,
    study_design: studyDesign,
    sample_size: sampleSize,
    primary_endpoint: primaryEndpoint,
    effect_size_summary: effectSizeSummary,
    disclaimer: MEDICAL_DISCLAIMER,
    not_medical_advice: true
  };
};

const medicalResearchSummaryVertical = defineVertical({
  id: 'medical_research_summary',
  name: 'Medical Research Summary',
  inputTypesAllowed: ['text', 'pdf'],
  rag: {
    enabled: true,
    storeInputAsDocs: true,
    topK: 10
  },
  promptTemplate: ({ inputText, context }) => [
    {
      role: 'system',
      content: MEDICAL_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: [
        'Return strict JSON matching this schema shape (camelCase keys required):',
        [
          '{',
          '"executiveSummary": string[],',
          '"evidenceQuotes": [{"quote": string, "relevance": string}],',
          '"risks": [{"title": string, "severity": "high"|"medium"|"low", "evidenceQuote": string, "impact": string, "mitigation": string}],',
          '"recommendations": [{"action": string, "rationale": string, "priority": "high"|"medium"|"low"}],',
          '"missingInfo": string[],',
          '"confidence": {"overall": "high"|"medium"|"low", "reasons": string[]},',
          '"metadata": {"useCaseKey": "medical_research_summary", "model"?: string, "provider"?: string, "createdAt": string},',
          '"researchQuestion": string,',
          '"studyDesign": string,',
          '"sampleSize": string,',
          '"primaryEndpoint": string,',
          '"effectSizeSummary": string',
          '}'
        ].join(' '),
        'Required narrative sections represented by fields: Executive Summary, Evidence Quotes, Risks, Recommendations, Missing Info, Confidence.',
        'Every claim in risks/recommendations must be anchored to evidenceQuotes using direct quotes from input text.',
        'If sampleSize/studyDesign/primaryEndpoint/effectSizeSummary are absent, return "Not provided".',
        'Do not output medical diagnosis or treatment advice. Provide research evidence analysis only.',
        context ? `Retrieved context:\n${context}` : '',
        `Medical research content:\n${inputText}`
      ]
        .filter(Boolean)
        .join('\n\n')
    }
  ],
  outputSchema: medicalResearchSummarySchema,
  postProcess: normalizeMedicalOutput,
  guardrails: createGuardrails({
    refusalRules: [
      {
        id: 'medical_direct_treatment',
        pattern: /\b(diagnose me|prescribe|dosage for me|what should i take|treat my)\b/i,
        reason: 'Refuses direct personalized diagnosis, prescription, or treatment requests.'
      },
      {
        id: 'medical_emergency_triage',
        pattern: /\b(chest pain what should i do right now|stroke symptoms what do i do|medical emergency advice)\b/i,
        reason: 'Refuses emergency triage instructions and directs to professional care.'
      },
      {
        id: 'medical_harm',
        pattern: /\b(harm myself|self-harm|suicide method)\b/i,
        reason: 'Refuses requests involving self-harm instructions.'
      }
    ]
  })
});

export default medicalResearchSummaryVertical;
