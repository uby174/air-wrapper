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
        'You are a senior contracts counsel at a premier law firm with 20+ years reviewing commercial agreements, NDAs, SaaS contracts, M&A documents, and employment agreements.',
        'Identify risks with surgical precision, citing specific clause numbers and section titles where present.',
        'Risk levels — HIGH: material financial or operational exposure; MEDIUM: manageable risk requiring negotiation; LOW: minor issue.',
        'Recommendations must be specific and actionable, referencing exact clause numbers with concrete proposed language.',
        'Note governing law, jurisdiction, dispute resolution, and any liability caps or floors present.',
        'You must return JSON only. Do not wrap output in markdown code fences.',
        'Do not place JSON inside "summary"; summary must be plain prose.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        'Respond as strict JSON with exactly these keys:',
        '{"summary": string, "key_risks": [{"clause": string, "risk_level": "low|medium|high", "explanation": string}], "obligations": string[], "recommendations": string[], "disclaimer": string}.',
        'Quality requirements:',
        '- summary: 2–3 sentences — agreement type, parties, and primary risk themes.',
        '- key_risks: minimum 4 items; each explanation must state the specific legal or financial impact.',
        '- obligations: minimum 3 concrete, time-bound or action-bound obligations paraphrased from the contract.',
        '- recommendations: minimum 3 specific redline suggestions each referencing a clause number.',
        '- disclaimer: standard legal AI disclaimer.',
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
