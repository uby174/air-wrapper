import { createHash } from 'node:crypto';
import type { JobInput } from '../jobs/types';

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /(?<!\d)(?:\+?\d[\d\s\-().]{8,}\d)(?!\d)/g;
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]*?){13,19}\b/g;
const NATIONAL_ID_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const IBAN_PATTERN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/gi;

const summarizeForStorage = (value: string, maxChars: number): string => {
  if (!value) return '';

  const redacted = value
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(CREDIT_CARD_PATTERN, '[redacted-card]')
    .replace(PHONE_PATTERN, '[redacted-phone]')
    .replace(NATIONAL_ID_PATTERN, '[redacted-id]')
    .replace(IBAN_PATTERN, '[redacted-iban]')
    .trim();

  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}...[truncated]`;
};

const hashContent = (value: string): string => createHash('sha256').update(value).digest('hex');

const normalizeStoredUrl = (value: string): string => {
  if (value.startsWith('data:')) {
    const digest = hashContent(value);
    return `https://redacted.local/data-upload#sha256=${digest}`;
  }

  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return `https://redacted.local/url#sha256=${hashContent(value)}`;
  }
};

export const shouldStoreRawInput = (): boolean => process.env.PRIVACY_STORE_RAW_INPUT === 'true';

export const minimizeJobInputForStorage = (input: JobInput): JobInput => {
  if (shouldStoreRawInput()) return input;

  if (input.type === 'text') {
    return {
      type: 'text',
      text: summarizeForStorage(input.text, 2000),
      ...(input.storageUrl ? { storageUrl: normalizeStoredUrl(input.storageUrl) } : {})
    };
  }

  return {
    type: 'pdf',
    storageUrl: normalizeStoredUrl(input.storageUrl)
  };
};
