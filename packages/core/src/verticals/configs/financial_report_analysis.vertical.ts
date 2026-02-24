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
import { financialReportAnalysisSchema, type FinancialReportAnalysisResult } from './financial_report_analysis.schema';

const FINANCE_DISCLAIMER = 'This analysis is informational and not investment advice.';
const FINANCIAL_SYSTEM_PROMPT = `You are a senior financial analyst and forensic reviewer. Analyze ONLY the provided report text.
Do not invent numbers, assumptions, benchmarks, market context, or company facts not present.

SAFETY / SCOPE
- This is analysis, not investment advice.
- Do not tell the user to buy/sell.

EVIDENCE RULE
- Any metric or claim must be supported by an exact quote from the input. If numbers are not provided, use “Not provided” and record in missingInfo.

OUTPUT FORMAT (MANDATORY)
Return ONLY valid JSON matching this structure exactly (no markdown, no extra keys, no commentary):
{
  "executiveSummary": ["..."],
  "evidenceQuotes": [{"quote":"...","relevance":"..."}],
  "risks": [{"title":"...","severity":"high|medium|low","evidenceQuote":"...","impact":"...","mitigation":"..."}],
  "recommendations": [{"action":"...","rationale":"...","priority":"high|medium|low"}],
  "missingInfo": ["..."],
  "confidence": {"overall":"high|medium|low","reasons":["..."]},
  "metadata": {"useCaseKey":"financial_report_analysis","provider":"Not provided","model":"Not provided","createdAt":"ISO-8601"}
}

QUALITY BAR
- risks must cover: liquidity, leverage, cash flow quality, one-offs, concentration, accounting ambiguity (if hinted).
- recommendations: what to request/check next (cash flow statement, notes, debt maturity schedule, segment breakdown).
- If no financial statements are present, confidence must be low and missingInfo must list the absent statements.

If the input is not a financial report, still return JSON and set confidence low.`;

const preferProvided = (primary: unknown, fallback: unknown): string => {
  const primaryValue = toNonEmptyString(primary, NOT_PROVIDED);
  if (primaryValue !== NOT_PROVIDED) return primaryValue;
  return toNonEmptyString(fallback, NOT_PROVIDED);
};

const normalizeFinancialOutput = (output: FinancialReportAnalysisResult): FinancialReportAnalysisResult => {
  const legacySummary = preferProvided(output.executive_summary, undefined);
  const executiveSummary =
    Array.isArray(output.executiveSummary) &&
    output.executiveSummary.length > 0 &&
    !(output.executiveSummary.length === 1 && output.executiveSummary[0] === NOT_PROVIDED)
      ? output.executiveSummary
      : toExecutiveSummaryArray(undefined, legacySummary);
  const evidenceQuotes = normalizeEvidenceQuotes(output.evidenceQuotes ?? output.evidence_quotes);
  const risks = normalizeStructuredRisks(output.risks);

  let recommendations = normalizeStructuredRecommendations(output.recommendations);
  if (recommendations.length === 0) {
    recommendations = [
      {
        action: 'Reconcile headline conclusions with audited statements and notes.',
        rationale: 'No structured recommendations were returned.',
        priority: 'high'
      }
    ];
  }

  const reportingPeriod = preferProvided(output.reportingPeriod, output.reporting_period);
  const revenueNumbers = preferProvided(output.revenueNumbers, output.revenue_numbers);
  const liquidityPosition = preferProvided(output.liquidityPosition, output.liquidity_position);

  let missingInfo = uniqueStrings([...toStringArray(output.missingInfo), ...toStringArray(output.missing_info)]);
  if (!hasProvidedValue(reportingPeriod)) missingInfo.push('reportingPeriod');
  if (!hasProvidedValue(revenueNumbers)) missingInfo.push('revenueNumbers');
  if (!hasProvidedValue(liquidityPosition)) missingInfo.push('liquidityPosition');
  if (evidenceQuotes.length === 0) missingInfo.push('evidenceQuotes');
  missingInfo = uniqueStrings(missingInfo);

  const metadataInput = output.metadata;
  const metadata = buildResultMetadata('financial_report_analysis', {
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
    reportingPeriod,
    revenueNumbers,
    liquidityPosition,
    executive_summary: executiveSummary.join(' ') || NOT_PROVIDED,
    evidence_quotes: evidenceQuotes.map((quote) => ({ ...quote, source_ref: 'input' })),
    missing_info: missingInfo,
    reporting_period: reportingPeriod,
    revenue_numbers: revenueNumbers,
    liquidity_position: liquidityPosition,
    disclaimer: FINANCE_DISCLAIMER
  };
};

const financialReportAnalysisVertical = defineVertical({
  id: 'financial_report_analysis',
  name: 'Financial Report Analysis',
  inputTypesAllowed: ['text', 'pdf'],
  rag: {
    enabled: true,
    storeInputAsDocs: true,
    topK: 8
  },
  promptTemplate: ({ inputText, context }) => [
    {
      role: 'system',
      content: FINANCIAL_SYSTEM_PROMPT
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
          '"metadata": {"useCaseKey": "financial_report_analysis", "model"?: string, "provider"?: string, "createdAt": string},',
          '"reportingPeriod": string,',
          '"revenueNumbers": string,',
          '"liquidityPosition": string',
          '}'
        ].join(' '),
        'Required narrative sections represented by fields: Executive Summary, Evidence Quotes, Risks, Recommendations, Missing Info, Confidence.',
        'Every claim in risks/recommendations must be anchored to evidenceQuotes using direct quotes from input text.',
        'If reportingPeriod/revenueNumbers/liquidityPosition are absent, return "Not provided".',
        'Do not output investment advice. Provide analytical findings and operational/accounting follow-up recommendations only.',
        context ? `Retrieved context:\n${context}` : '',
        `Financial report content:\n${inputText}`
      ]
        .filter(Boolean)
        .join('\n\n')
    }
  ],
  outputSchema: financialReportAnalysisSchema,
  postProcess: normalizeFinancialOutput,
  guardrails: createGuardrails({
    refusalRules: [
      {
        id: 'finance_personal_investment_advice',
        pattern: /\b(should i buy|should i sell|what stock should i buy|tell me what to invest in|guaranteed return)\b/i,
        reason: 'Refuses personalized investment advice requests.'
      },
      {
        id: 'finance_insider',
        pattern: /\b(insider trading|non-public material information|mnpi)\b/i,
        reason: 'Refuses requests involving insider trading.'
      },
      {
        id: 'finance_manipulation',
        pattern: /\b(pump and dump|manipulate (the )?market|wash trading)\b/i,
        reason: 'Refuses assistance with market manipulation.'
      }
    ]
  })
});

export default financialReportAnalysisVertical;
