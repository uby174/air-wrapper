import { createGuardrails } from '../guardrails';
import { legalContractAnalysisSchema } from './legal_contract_analysis.schema';
import { defineVertical } from '../types';

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
      content: [
        'You are a senior contracts counsel specializing in commercial risk review.',
        'You must return JSON only.',
        'Focus on clauses, obligations, and contractual risks.',
        'Do not wrap output in markdown code fences.',
        'Do not place JSON inside "summary"; it must be plain text.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        'Respond as strict JSON with keys:',
        '{"summary": string, "key_risks": [{"clause": string, "risk_level": "low|medium|high", "explanation": string}],',
        '"obligations": string[], "recommendations": string[], "disclaimer": string}.',
        'Completeness requirements: include at least 4 key_risks and at least 3 recommendations when evidence exists.',
        'For each key_risk, reference a concrete clause/section title where possible.',
        context ? `Retrieved context:\n${context}` : '',
        `Contract content:\n${inputText}`
      ]
        .filter(Boolean)
        .join('\n\n')
    }
  ],
  outputSchema: legalContractAnalysisSchema,
  postProcess: (output) => ({
    ...output,
    disclaimer: output.disclaimer || 'This is an AI analysis and not legal advice.'
  }),
  guardrails: createGuardrails({
    refusalRules: [
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
