import { createGuardrails } from '../guardrails';
import { defineVertical } from '../types';
import { genericAnalysisSchema } from './generic_analysis.schema';

const genericAnalysisVertical = defineVertical({
  id: 'generic_analysis',
  name: 'Generic Analysis',
  inputTypesAllowed: ['text', 'pdf'],
  rag: {
    enabled: false,
    storeInputAsDocs: false,
    topK: 6
  },
  promptTemplate: ({ inputText, context, useCase }) => [
    {
      role: 'system',
      content: 'You are a general purpose AI analysis assistant. Return JSON only.'
    },
    {
      role: 'user',
      content: [
        'Use case:',
        useCase,
        'Respond as strict JSON: {"answer": string, "key_points": string[]}.',
        context ? `Retrieved context:\n${context}` : '',
        `Input:\n${inputText}`
      ]
        .filter(Boolean)
        .join('\n\n')
    }
  ],
  outputSchema: genericAnalysisSchema,
  guardrails: createGuardrails({
    refusalRules: [
      {
        id: 'generic_violent_harm',
        pattern: /\bmake a bomb|build a weapon|kill someone\b/i,
        reason: 'Refuses requests to facilitate violent harm.'
      }
    ]
  })
});

export default genericAnalysisVertical;
