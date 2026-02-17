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
        'You are a senior equity research analyst specializing in forensic financial statement review.',
        'You must return JSON only.',
        'Do not provide market manipulation or insider guidance.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        'Respond as strict JSON with keys:',
        '{"executive_summary": string, "key_metrics": [{"metric": string, "value": string, "interpretation": string}],',
        '"risk_flags": string[], "recommendations": string[], "disclaimer": string}.',
        'Do not wrap output in markdown code fences.',
        'Do not place JSON inside "executive_summary"; it must be plain text.',
        'Provide at least 4 key_metrics, 4 risk_flags, and 4 recommendations when evidence exists.',
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
