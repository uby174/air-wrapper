import { describe, expect, it } from 'vitest';
import { evaluateVerticalGuardrails, getVertical, seededVerticals } from '../verticals';

describe('vertical configs', () => {
  it('loads all seeded verticals with required structure', async () => {
    for (const verticalId of seededVerticals) {
      const vertical = await getVertical(verticalId);

      expect(vertical.id).toBe(verticalId);
      expect(vertical.name.length).toBeGreaterThan(0);
      expect(vertical.inputTypesAllowed.length).toBeGreaterThan(0);
      expect(typeof vertical.promptTemplate).toBe('function');
      expect(vertical.rag.topK).toBeGreaterThan(0);

      const messages = vertical.promptTemplate({
        inputText: 'Sample input text for vertical prompt building.',
        context: '[C1] sample context',
        useCase: vertical.id
      });

      expect(messages.length).toBeGreaterThan(0);
      expect(messages.some((message) => message.role === 'user')).toBe(true);
    }
  });

  it('supports unknown vertical ids via generic fallback', async () => {
    const vertical = await getVertical('unknown_custom_vertical');
    expect(vertical.id).toBe('unknown_custom_vertical');
    expect(vertical.name.toLowerCase()).toContain('generic analysis');
  });

  it('normalizes unsafe use_case input before loading fallback', async () => {
    const vertical = await getVertical('../Unknown Vertical !!');
    expect(vertical.id).toBe('unknown_vertical');
    expect(vertical.name.toLowerCase()).toContain('generic analysis');
  });

  it('applies pii redaction and refusal rules', async () => {
    const vertical = await getVertical('medical_research_summary');
    const result = evaluateVerticalGuardrails(
      'Email me at test@example.com and diagnose me immediately.',
      vertical.guardrails
    );

    expect(result.sanitizedInput).toContain('[REDACTED_EMAIL]');
    expect(result.piiMatches.length).toBeGreaterThan(0);
    expect(result.refusalMatches.length).toBeGreaterThan(0);
  });
});
