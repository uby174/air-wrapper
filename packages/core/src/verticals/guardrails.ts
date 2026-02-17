import type { VerticalGuardrailEvaluation, VerticalGuardrails } from './types';

const cloneRegex = (pattern: RegExp, forceGlobal = false): RegExp => {
  const flags = pattern.flags.includes('g') || !forceGlobal ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
};

const hasMatch = (pattern: RegExp, input: string): boolean => cloneRegex(pattern, false).test(input);

export const evaluateVerticalGuardrails = (
  inputText: string,
  guardrails: VerticalGuardrails
): VerticalGuardrailEvaluation => {
  let sanitizedInput = inputText;
  const piiMatches: string[] = [];
  const refusalMatches: Array<{ id: string; reason: string }> = [];

  for (const piiRule of guardrails.piiRules) {
    if (!hasMatch(piiRule.pattern, sanitizedInput)) continue;
    piiMatches.push(piiRule.id);
    sanitizedInput = sanitizedInput.replace(cloneRegex(piiRule.pattern, true), piiRule.replacement);
  }

  for (const refusalRule of guardrails.refusalRules) {
    if (!hasMatch(refusalRule.pattern, sanitizedInput)) continue;
    refusalMatches.push({
      id: refusalRule.id,
      reason: refusalRule.reason
    });
  }

  return {
    sanitizedInput,
    piiMatches,
    refusalMatches
  };
};

const COMMON_PII_RULES = [
  {
    id: 'pii_email',
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    replacement: '[REDACTED_EMAIL]',
    description: 'Masks email addresses.'
  },
  {
    id: 'pii_phone',
    pattern: /\b(?:\+?\d{1,2}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?){2}\d{4}\b/g,
    replacement: '[REDACTED_PHONE]',
    description: 'Masks phone numbers.'
  },
  {
    id: 'pii_ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[REDACTED_SSN]',
    description: 'Masks US social security numbers.'
  }
] as const;

export const createGuardrails = (params: {
  refusalRules: Array<{
    id: string;
    pattern: RegExp;
    reason: string;
  }>;
}): VerticalGuardrails => ({
  piiRules: COMMON_PII_RULES.map((rule) => ({ ...rule })),
  refusalRules: params.refusalRules
});
