import { createGuardrails } from '../guardrails';
import { defineVertical } from '../types';
import { HealthInsuranceSchema } from './insurance_health.schema';

const HEALTH_INSURANCE_SYSTEM_PROMPT = `
You are a friendly, knowledgeable health insurance advisor helping ordinary people
understand their insurance policy. Your user is NOT a lawyer or expert — they may be
a student, young worker, or family member trying to make sense of confusing insurance
documents. Use plain, simple English. No jargon. If you must use a term like
'deductible', explain it in brackets: deductible (the amount you pay before insurance
kicks in). Be honest about risks. Be encouraging about genuine benefits. Focus on
practical real-world implications: what does this actually mean for a person's life?
Never give medical advice. Never recommend a specific plan. Return valid JSON only.

Guardrails:
- Warn requests about pre-existing condition coverage (note: laws vary by country).
`;

const insuranceHealthVertical = defineVertical({
  id: 'insurance_health',
  name: 'Health Insurance Policy',
  inputTypesAllowed: ['text', 'pdf'],
  rag: {
    enabled: true,
    storeInputAsDocs: true,
    topK: 10
  },
  promptTemplate: ({ inputText, context }) => [
    {
      role: 'system',
      content: HEALTH_INSURANCE_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: [
        'Analyze the provided health insurance policy document and return strict JSON matching this schema:',
        JSON.stringify({
          plain_summary: 'string',
          plan_type: 'string',
          monthly_cost: {
            premium: 'string',
            deductible: 'string',
            out_of_pocket_max: 'string',
            copays: ['string']
          },
          what_is_covered: [
            { category: 'string', covered: true, details: 'string' }
          ],
          what_is_NOT_covered: [
            { exclusion: 'string', reason: 'string', impact: 'string' }
          ],
          risks: [
            {
              title: 'string',
              description: 'string',
              severity: 'low|medium|high',
              what_to_watch_out_for: 'string'
            }
          ],
          benefits: [
            { title: 'string', description: 'string', value_to_you: 'string' }
          ],
          most_important: ['string'],
          questions_to_ask: ['string'],
          red_flags: ['string'],
          overall_rating: {
            score: 0,
            verdict: 'excellent|good|fair|poor|avoid',
            one_line_summary: 'string'
          },
          disclaimer: 'string'
        }, null, 2),
        'Ensure all explanations are in plain English.',
        'If specific costs are not found, state "Not provided" or estimate if ranges are given.',
        context ? `Retrieved context:\n${context}` : '',
        `Policy Document:\n${inputText}`
      ]
        .filter(Boolean)
        .join('\n\n')
    }
  ],
  outputSchema: HealthInsuranceSchema,
  guardrails: createGuardrails({
    refusalRules: [
      {
        id: 'fraud_prevention',
        pattern: /\b(forge|fake|misrepresent|lie about|hide)\s+(my\s+)?(condition|health|history|diagnosis)\b/i,
        reason: 'Refuses requests to forge or misrepresent health conditions.'
      },
      {
        id: 'medical_advice',
        pattern: /\b(diagnose me|treatment for|what should i take|cure for)\b/i,
        reason: 'Refuses requests for medical diagnosis or treatment advice.'
      }
    ]
  })
});

export default insuranceHealthVertical;
