import { describe, expect, it } from 'vitest';
import { ExpertAnalysisResultSchema } from '@ai-wrapper/shared';
import { getVertical } from '../verticals';

const REQUIRED_SCHEMA_FIELDS = [
  'executiveSummary',
  'evidenceQuotes',
  'risks',
  'recommendations',
  'missingInfo',
  'confidence',
  'metadata'
] as const;

const buildPromptText = async (verticalId: string, locale?: string): Promise<string> => {
  const vertical = await getVertical(verticalId);
  const messages = vertical.promptTemplate({
    inputText: 'Minimal input with no governing law, no sample size, and no revenue numbers.',
    context: '[C1] Context snippet',
    useCase: vertical.id,
    locale
  });
  return messages.map((message) => message.content).join('\n\n');
};

describe('expert analysis vertical contracts', () => {
  it.each([
    ['legal_contract_analysis', 'governingLaw'],
    ['medical_research_summary', 'sampleSize'],
    ['financial_report_analysis', 'revenueNumbers']
  ] as const)(
    'prompt contains required headings/fields and "Not provided" rule for %s',
    async (verticalId, missingFieldName) => {
      const prompt = await buildPromptText(verticalId);

      expect(prompt).toContain('Return ONLY valid JSON');
      expect(prompt).toContain('Not provided');
      expect(prompt).toContain('exact quote');
      expect(prompt).toContain(missingFieldName);

      for (const field of REQUIRED_SCHEMA_FIELDS) {
        expect(prompt).toContain(field);
      }

      expect(prompt).toContain('Executive Summary');
      expect(prompt).toContain('Evidence Quotes');
      expect(prompt).toContain('Risks');
      expect(prompt).toContain('Recommendations');
      expect(prompt).toContain('Missing Info');
      expect(prompt).toContain('Confidence');
    }
  );

  it('schema validation passes for correct sample outputs (all three use cases)', async () => {
    const legal = await getVertical('legal_contract_analysis');
    const medical = await getVertical('medical_research_summary');
    const financial = await getVertical('financial_report_analysis');

    expect(() =>
      legal.outputSchema.parse({
        executiveSummary: ['Executive summary line 1'],
        evidenceQuotes: [{ quote: 'Clause 5.1 governs indemnity.', relevance: 'Supports indemnity risk.' }],
        risks: [
          {
            title: 'Broad indemnity',
            severity: 'high',
            evidenceQuote: 'Customer shall indemnify...',
            impact: 'Unlimited exposure',
            mitigation: 'Cap indemnity and narrow scope'
          }
        ],
        recommendations: [
          {
            action: 'Request indemnity cap',
            rationale: 'Reduce uncapped exposure',
            priority: 'high'
          }
        ],
        missingInfo: ['governingLaw'],
        confidence: { overall: 'medium', reasons: ['Partial contract excerpt provided'] },
        metadata: {
          useCaseKey: 'legal_contract_analysis',
          createdAt: new Date().toISOString()
        },
        governingLaw: 'Not provided'
      })
    ).not.toThrow();

    expect(() =>
      medical.outputSchema.parse({
        executiveSummary: ['Trial summary'],
        evidenceQuotes: [{ quote: 'n=120 participants', relevance: 'Sample size evidence' }],
        risks: [
          {
            title: 'Short follow-up',
            severity: 'medium',
            evidenceQuote: 'n=120 participants',
            impact: 'Long-term outcomes uncertain',
            mitigation: 'Require longer follow-up data'
          }
        ],
        recommendations: [
          { action: 'Verify primary endpoint definition', rationale: 'Endpoint wording is ambiguous', priority: 'medium' }
        ],
        missingInfo: [],
        confidence: { overall: 'high', reasons: ['Multiple explicit study parameters provided'] },
        metadata: { useCaseKey: 'medical_research_summary', createdAt: new Date().toISOString() },
        sampleSize: '120'
      })
    ).not.toThrow();

    expect(() =>
      financial.outputSchema.parse({
        executiveSummary: ['Quarterly revenue increased, liquidity tightened.'],
        evidenceQuotes: [{ quote: 'Revenue increased 12% YoY', relevance: 'Revenue trend evidence' }],
        risks: [
          {
            title: 'Liquidity tightening',
            severity: 'high',
            evidenceQuote: 'Revenue increased 12% YoY',
            impact: 'Higher refinancing risk',
            mitigation: 'Review debt maturities and cash runway'
          }
        ],
        recommendations: [
          { action: 'Analyze debt covenant headroom', rationale: 'Liquidity risk identified', priority: 'high' }
        ],
        missingInfo: [],
        confidence: { overall: 'medium', reasons: ['Headline figures provided without full notes'] },
        metadata: { useCaseKey: 'financial_report_analysis', createdAt: new Date().toISOString() },
        revenueNumbers: '$10M'
      })
    ).not.toThrow();
  });

  it('shared ExpertAnalysisResultSchema validates a compliant base contract and rejects invalid shapes', () => {
    expect(() =>
      ExpertAnalysisResultSchema.parse({
        executiveSummary: ['Line 1'],
        evidenceQuotes: [{ quote: 'Exact source line', relevance: 'Supports claim' }],
        risks: [
          {
            title: 'Contractual ambiguity',
            severity: 'medium',
            evidenceQuote: 'Not provided',
            impact: 'Interpretation risk',
            mitigation: 'Clarify wording'
          }
        ],
        recommendations: [{ action: 'Clarify term', rationale: 'Reduce ambiguity', priority: 'high' }],
        missingInfo: ['governingLaw'],
        confidence: { overall: 'low', reasons: ['Only partial text provided'] },
        metadata: {
          useCaseKey: 'legal_contract_analysis',
          provider: 'Not provided',
          model: 'Not provided',
          createdAt: new Date().toISOString()
        }
      })
    ).not.toThrow();

    expect(() =>
      ExpertAnalysisResultSchema.parse({
        executiveSummary: [],
        evidenceQuotes: [{ quote: '', relevance: '' }],
        risks: [{ title: 'x', severity: 'urgent', impact: 'x', mitigation: 'x' }],
        recommendations: [{ action: 'x', rationale: 'x', priority: 'urgent' }],
        missingInfo: ['x'],
        confidence: { overall: 'urgent', reasons: [] },
        metadata: { useCaseKey: 'bad_key', createdAt: 'not-iso' }
      })
    ).toThrow();
  });

  it('schema validation fails for invalid output shape', async () => {
    const legal = await getVertical('legal_contract_analysis');

    expect(() =>
      legal.outputSchema.parse({
        executiveSummary: [123],
        evidenceQuotes: [{ quote: '', relevance: '' }],
        risks: [{ title: '', severity: 'urgent', impact: '', mitigation: '' }],
        recommendations: [{ action: '', rationale: '', priority: 'urgent' }],
        missingInfo: [123],
        confidence: { overall: 'urgent', reasons: [123] },
        metadata: { useCaseKey: 'wrong_vertical', createdAt: '' }
      })
    ).toThrow();
  });

  it('minimal output is normalized to include "Not provided" fields or missingInfo markers', async () => {
    const legal = await getVertical('legal_contract_analysis');
    const medical = await getVertical('medical_research_summary');
    const financial = await getVertical('financial_report_analysis');

    const legalOut = (legal.postProcess
      ? await legal.postProcess(
          legal.outputSchema.parse({
            summary: 'Brief contract summary.',
            key_risks: [],
            obligations: [],
            recommendations: [],
            disclaimer: 'This is an AI analysis and not legal advice.'
          }) as never
        )
      : null) as Record<string, unknown>;
    expect(legalOut.governingLaw).toBe('Not provided');
    expect(legalOut.missingInfo).toContain('governingLaw');

    const medicalOut = (medical.postProcess
      ? await medical.postProcess(
          medical.outputSchema.parse({
            evidence_summary: 'Brief evidence summary.',
            key_findings: [],
            limitations: [],
            safety_notes: [],
            not_medical_advice: true
          }) as never
        )
      : null) as Record<string, unknown>;
    expect(medicalOut.sampleSize).toBe('Not provided');
    expect(medicalOut.missingInfo).toContain('sampleSize');

    const financialOut = (financial.postProcess
      ? await financial.postProcess(
          financial.outputSchema.parse({
            executive_summary: 'Brief financial summary.',
            key_metrics: [],
            risk_flags: [],
            recommendations: [],
            disclaimer: 'This analysis is informational and not investment advice.'
          }) as never
        )
      : null) as Record<string, unknown>;
    expect(financialOut.revenueNumbers).toBe('Not provided');
    expect(financialOut.missingInfo).toContain('revenueNumbers');
  });
});
