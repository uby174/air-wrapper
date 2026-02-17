import { describe, expect, it } from 'vitest';
import { minimizeJobInputForStorage } from '../data-minimization';

describe('minimizeJobInputForStorage', () => {
  it('redacts common PII from text input when raw storage is disabled', () => {
    process.env.PRIVACY_STORE_RAW_INPUT = 'false';

    const minimized = minimizeJobInputForStorage({
      type: 'text',
      text: 'Contact john.doe@example.com or +1 (555) 123-4567. Card 4111 1111 1111 1111.'
    });

    expect(minimized.type).toBe('text');
    expect(minimized.text).toContain('[redacted-email]');
    expect(minimized.text).toContain('[redacted-phone]');
    expect(minimized.text).toContain('[redacted-card]');
  });

  it('replaces data URLs with hashed placeholders', () => {
    process.env.PRIVACY_STORE_RAW_INPUT = 'false';

    const minimized = minimizeJobInputForStorage({
      type: 'pdf',
      storageUrl: 'data:application/pdf;base64,ZmFrZS1wZGY='
    });

    expect(minimized.type).toBe('pdf');
    expect(minimized.storageUrl.startsWith('https://redacted.local/data-upload#sha256=')).toBe(true);
  });
});
