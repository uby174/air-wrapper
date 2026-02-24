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
import { legalContractAnalysisSchema, type LegalContractAnalysisResult } from './legal_contract_analysis.schema';

const LEGAL_DISCLAIMER = 'This is an AI analysis and not legal advice.';
const LEGAL_SYSTEM_PROMPT = `You are a senior contract lawyer and commercial risk analyst. You analyze ONLY the provided contract text.
You must not invent clauses, parties, jurisdictions, dates, amounts, or obligations. If information is missing, state “Not provided” and add it to missingInfo.

SAFETY / SCOPE
- You provide document analysis, not legal advice.
- You must not recommend illegal actions or evasion.

EVIDENCE RULE
- Every risk must include an evidenceQuote that is an exact quote from the input text, unless the risk is “Missing clause / ambiguity”, in which case evidenceQuote must be "Not provided".

OUTPUT FORMAT (MANDATORY)
Return ONLY valid JSON matching this structure exactly (no markdown, no extra keys, no commentary):
{
  "executiveSummary": ["..."],
  "evidenceQuotes": [{"quote":"...","relevance":"..."}],
  "risks": [{"title":"...","severity":"high|medium|low","evidenceQuote":"...","impact":"...","mitigation":"..."}],
  "recommendations": [{"action":"...","rationale":"...","priority":"high|medium|low"}],
  "missingInfo": ["..."],
  "confidence": {"overall":"high|medium|low","reasons":["..."]},
  "metadata": {"useCaseKey":"legal_contract_analysis","provider":"Not provided","model":"Not provided","createdAt":"ISO-8601"}
}

QUALITY BAR
- executiveSummary: max 5 items, decision-ready.
- evidenceQuotes: 3–10 quotes, short and precise.
- risks: 5–12 items. Must include liability, termination, IP, confidentiality, payment, scope/acceptance (if applicable).
- recommendations: 5–10 actionable edits or negotiation moves. Prefer concrete clause revisions (describe the change clearly).
- missingInfo: list what is absent or ambiguous (governing law, limitation of liability cap, term/renewal, etc.).

If the input is not a contract or is too short to analyze, still return JSON and set confidence to low with clear reasons.`;

const preferProvided = (primary: unknown, fallback: unknown): string => {
  const primaryValue = toNonEmptyString(primary, NOT_PROVIDED);
  if (primaryValue !== NOT_PROVIDED) return primaryValue;
  return toNonEmptyString(fallback, NOT_PROVIDED);
};

const normalizeLegalOutput = (output: LegalContractAnalysisResult): LegalContractAnalysisResult => {
  const legacySummary = preferProvided(output.executive_summary, output.summary);
  const executiveSummary =
    Array.isArray(output.executiveSummary) &&
    output.executiveSummary.length > 0 &&
    !(output.executiveSummary.length === 1 && output.executiveSummary[0] === NOT_PROVIDED)
      ? output.executiveSummary
      : toExecutiveSummaryArray(undefined, legacySummary);
  const evidenceQuotes = normalizeEvidenceQuotes(output.evidenceQuotes ?? output.evidence_quotes);
  const keyRisks = Array.isArray(output.key_risks) ? output.key_risks : [];
  const risks =
    normalizeStructuredRisks(output.risks).length > 0
      ? normalizeStructuredRisks(output.risks)
      : keyRisks.map((risk) => ({
          title: toNonEmptyString(risk.clause, 'Contract risk'),
          severity: risk.risk_level,
          evidenceQuote: NOT_PROVIDED,
          impact: risk.explanation,
          mitigation: 'Review and negotiate the cited clause before execution.'
        }));

  let recommendations = normalizeStructuredRecommendations(output.recommendations);
  if (recommendations.length === 0) {
    recommendations = [
      {
        action: 'Request contract redlines for all high-impact risks identified.',
        rationale: 'No structured recommendations were returned.',
        priority: 'high'
      }
    ];
  }

  const contractType = preferProvided(output.contractType, output.contract_type);
  const parties = preferProvided(output.parties, undefined);
  const governingLaw = preferProvided(output.governingLaw, output.governing_law);
  const jurisdiction = preferProvided(output.jurisdiction, undefined);
  const disputeResolution = preferProvided(output.disputeResolution, output.dispute_resolution);
  const liabilityCap = preferProvided(output.liabilityCap, output.liability_cap);

  let missingInfo = uniqueStrings([...toStringArray(output.missingInfo), ...toStringArray(output.missing_info)]);
  if (!hasProvidedValue(contractType)) missingInfo.push('contractType');
  if (!hasProvidedValue(parties)) missingInfo.push('parties');
  if (!hasProvidedValue(governingLaw)) missingInfo.push('governingLaw');
  if (!hasProvidedValue(jurisdiction)) missingInfo.push('jurisdiction');
  if (!hasProvidedValue(disputeResolution)) missingInfo.push('disputeResolution');
  if (!hasProvidedValue(liabilityCap)) missingInfo.push('liabilityCap');
  if (evidenceQuotes.length === 0) missingInfo.push('evidenceQuotes');
  missingInfo = uniqueStrings(missingInfo);

  const summaryText = executiveSummary.join(' ');
  const metadataInput = output.metadata;
  const metadata = buildResultMetadata('legal_contract_analysis', {
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
    contractType,
    parties,
    governingLaw,
    jurisdiction,
    disputeResolution,
    liabilityCap,
    summary: summaryText || NOT_PROVIDED,
    executive_summary: summaryText || NOT_PROVIDED,
    evidence_quotes: evidenceQuotes.map((quote) => ({ ...quote, source_ref: 'input' })),
    missing_info: missingInfo,
    contract_type: contractType,
    governing_law: governingLaw,
    dispute_resolution: disputeResolution,
    liability_cap: liabilityCap,
    disclaimer: LEGAL_DISCLAIMER
  };
};

const legalContractAnalysisVertical = defineVertical({
  id: 'legal_contract_analysis',
  name: 'Legal Contract Analysis',
  inputTypesAllowed: ['text', 'pdf'],
  rag: {
    enabled: true,
    storeInputAsDocs: true,
    topK: 8
  },
  promptTemplate: ({ inputText, context }) => [
    {
      role: 'system',
      content: LEGAL_SYSTEM_PROMPT
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
          '"metadata": {"useCaseKey": "legal_contract_analysis", "model"?: string, "provider"?: string, "createdAt": string},',
          '"contractType": string,',
          '"parties": string,',
          '"governingLaw": string,',
          '"jurisdiction": string,',
          '"disputeResolution": string,',
          '"liabilityCap": string',
          '}'
        ].join(' '),
        'Required narrative sections represented by fields: Executive Summary, Evidence Quotes, Risks, Recommendations, Missing Info, Confidence.',
        'Every claim in risks/recommendations must be anchored to evidenceQuotes using direct quotes from input text.',
        'If governingLaw/jurisdiction/disputeResolution/liabilityCap/contractType/parties are absent, return "Not provided".',
        'Do not output legal advice. Provide analytical observations and process recommendations only.',
        context ? `Retrieved context:\n${context}` : '',
        `Contract content:\n${inputText}`
      ]
        .filter(Boolean)
        .join('\n\n')
    }
  ],
  outputSchema: legalContractAnalysisSchema,
  postProcess: normalizeLegalOutput,
  guardrails: createGuardrails({
    refusalRules: [
      {
        id: 'legal_personalized_advice',
        pattern: /\b(should i sign|what legal action should i take|represent me|how do i win my lawsuit)\b/i,
        reason: 'Refuses personalized legal advice or representation requests.'
      },
      {
        id: 'legal_fraud',
        pattern: /\bforge|falsify|backdate|fabricate\b/i,
        reason: 'Refuses assistance with fraudulent document activity.'
      },
      {
        id: 'legal_evasion',
        pattern: /\bhide from regulators|evade the law|bypass compliance\b/i,
        reason: 'Refuses assistance intended to evade legal obligations.'
      }
    ]
  })
});

export default legalContractAnalysisVertical;
