import { createGuardrails } from '../guardrails';
import { medicalResearchSummarySchema } from './medical_research_summary.schema';
import { defineVertical } from '../types';

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
      content: [
        'You are a clinical research methodologist and evidence synthesis specialist.',
        'You must return JSON only.',
        'Do not provide diagnosis or treatment plans.',
        'Do not wrap output in markdown code fences.',
        'Do not place JSON inside "evidence_summary"; it must be plain text.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        'Respond as strict JSON with keys:',
        '{"research_question": string, "evidence_summary": string, "key_findings": string[],',
        '"limitations": string[], "safety_notes": string[], "not_medical_advice": true}.',
        'Completeness requirements: include at least 5 key_findings, 4 limitations, and 4 safety_notes when evidence exists.',
        'Prioritize study design, sample size, population, endpoints, effect direction/magnitude, and confidence limits when available.',
        context ? `Retrieved context:\n${context}` : '',
        `Medical research content:\n${inputText}`
      ]
        .filter(Boolean)
        .join('\n\n')
    }
  ],
  outputSchema: medicalResearchSummarySchema,
  guardrails: createGuardrails({
    refusalRules: [
      {
        id: 'medical_direct_treatment',
        pattern: /\bdiagnose me|prescribe|dosage for me|how much should i take\b/i,
        reason: 'Refuses direct personalized diagnosis or prescription requests.'
      },
      {
        id: 'medical_harm',
        pattern: /\bharm myself|self-harm|suicide method\b/i,
        reason: 'Refuses requests involving self-harm instructions.'
      }
    ]
  })
});

export default medicalResearchSummaryVertical;
