import { createGuardrails } from '../guardrails';
import { financialReportAnalysisSchema } from './financial_report_analysis.schema';
import { defineVertical } from '../types';

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
      content: [
        'You are a senior equity research analyst, CFA, with 18+ years specializing in forensic financial statement analysis, credit risk assessment, and corporate valuation.',
        'Apply rigorous GAAP/IFRS analysis. Calculate and interpret key ratios: revenue growth, gross margin, EBITDA margin, FCF conversion, DSO, debt/EBITDA, ROE, ROIC.',
        'Identify accounting red flags: channel stuffing, premature revenue recognition, off-balance-sheet liabilities, aggressive goodwill, related-party transactions.',
        'Provide specific, actionable investment recommendations with valuation context and price targets where supportable.',
        'Do not provide market manipulation or insider guidance.',
        'You must return JSON only. Do not wrap output in markdown code fences.',
        'Do not place JSON inside "executive_summary"; it must be plain prose.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        'Respond as strict JSON with exactly these keys:',
        '{"executive_summary": string, "key_metrics": [{"metric": string, "value": string, "interpretation": string}], "risk_flags": string[], "recommendations": string[], "disclaimer": string}.',
        'Quality requirements:',
        '- executive_summary: 2–4 sentences — period covered, headline financial performance, and primary concerns.',
        '- key_metrics: minimum 4 items; each interpretation must explain the business implication, not just restate the number.',
        '- risk_flags: minimum 4 items; each must name a specific accounting or operational concern with supporting evidence.',
        '- recommendations: minimum 4 items; each must reference a specific metric or finding and state a concrete action.',
        '- disclaimer: standard financial AI disclaimer.',
        context ? `Retrieved context:\n${context}` : '',
        `Financial report content:\n${inputText}`
      ]
        .filter(Boolean)
        .join('\n\n')
    }
  ],
  outputSchema: financialReportAnalysisSchema,
  postProcess: (output) => ({
    ...output,
    disclaimer: output.disclaimer || 'This analysis is informational and not investment advice.'
  }),
  guardrails: createGuardrails({
    refusalRules: [
      {
        id: 'finance_insider',
        pattern: /\binsider trading|non-public material information|mnpi\b/i,
        reason: 'Refuses requests involving insider trading.'
      },
      {
        id: 'finance_manipulation',
        pattern: /\bpump and dump|manipulate (the )?market|wash trading\b/i,
        reason: 'Refuses assistance with market manipulation.'
      }
    ]
  })
});

export default financialReportAnalysisVertical;
