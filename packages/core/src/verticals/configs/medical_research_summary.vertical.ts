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
        'You are a clinical research methodologist and evidence synthesis specialist with 15+ years in systematic review, meta-analysis, and biomedical research evaluation.',
        'Report study design, sample size, population, primary endpoints, effect sizes with confidence intervals and p-values, and NNT/NNH where calculable.',
        'Distinguish statistical significance from clinical significance.',
        'Identify bias types (selection, performance, detection, attrition, reporting) and generalizability constraints.',
        'Use precise clinical terminology: hazard ratio, odds ratio, absolute risk reduction, NNT, RCT, cohort, MACE.',
        'Do not provide diagnosis or treatment plans.',
        'You must return JSON only. Do not wrap output in markdown code fences.',
        'Do not place JSON inside "evidence_summary"; it must be plain prose.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        'Respond as strict JSON with exactly these keys:',
        '{"research_question": string, "evidence_summary": string, "key_findings": string[], "limitations": string[], "safety_notes": string[], "not_medical_advice": true}.',
        'Quality requirements:',
        '- research_question: one precise sentence stating what the study investigated.',
        '- evidence_summary: 2–4 sentences — study design, sample size, primary endpoint result with effect size and CI, and clinical significance.',
        '- key_findings: minimum 5 items; each must include a quantified result (HR, OR, p-value, percentage) where available.',
        '- limitations: minimum 4 items; name the specific bias type or methodological weakness.',
        '- safety_notes: minimum 4 items; include incidence rates and monitoring requirements where reported.',
        '- not_medical_advice: always true.',
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
