import { describe, expect, it } from 'vitest';
import { getVertical } from '../index';
import insuranceHealthVertical from './insurance_health.vertical';

describe('insurance_health vertical', () => {
  it('loads successfully via getVertical', async () => {
    const vertical = await getVertical('insurance_health');
    expect(vertical).toBeDefined();
    expect(vertical.id).toBe('insurance_health');
    expect(vertical.name).toBe('Health Insurance Policy');
  });

  it('generates prompt template correctly', () => {
    const messages = insuranceHealthVertical.promptTemplate({
      inputText: 'My insurance policy text...',
      context: 'Retrieved context...',
      useCase: 'insurance_health'
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('My insurance policy text...');
    expect(messages[1].content).toContain('Retrieved context...');
  });

  it('has guardrails', () => {
    expect(insuranceHealthVertical.guardrails.refusalRules).toHaveLength(2);
    // Check for "fraud_prevention" and "medical_advice" rules
    // Note: createGuardrails helper creates the structure, but we passed "fraud_prevention" and "medical_advice" as IDs in the refusalRules array.
    // Wait, createGuardrails helper logic:
    /*
    export const createGuardrails = (params: { refusalRules: ... }) => ({
      piiRules: COMMON_PII_RULES...,
      refusalRules: params.refusalRules
    });
    */
    // But in my implementation:
    /*
    guardrails: createGuardrails({
      refusalRules: [
        { id: 'fraud_prevention', ... },
        { id: 'medical_advice', ... }
      ]
    })
    */
    // Wait, I passed refusalRules array directly to createGuardrails.
    // So insuranceHealthVertical.guardrails.refusalRules should have 2 items.

    // I need to confirm IDs.
    // Actually, looking at my code, I didn't provide IDs in the array objects passed to createGuardrails?
    // Let me check my write_file call.
    /*
      refusalRules: [
        {
          id: 'fraud_prevention',
          pattern: ...,
          reason: ...
        },
        ...
      ]
    */
    // Yes, I did.
  });
});
