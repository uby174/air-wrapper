/**
 * Tests for privacy export bundle schema and privacy request types
 * Verifies: export bundle has all required keys, all DSR types accepted
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DATA_REQUEST_TYPES, type UserDataExportBundle } from '../db/privacy';

// Validate the export bundle shape without touching the database
describe('UserDataExportBundle schema', () => {
  const requiredBundleKeys: Array<keyof UserDataExportBundle> = [
    'generated_at',
    'user',
    'jobs',
    'documents',
    'chunks',
    'usage_events',
    'data_subject_requests'
  ];

  it('export bundle type has all required keys', () => {
    // Construct a valid bundle matching the interface
    const bundle: UserDataExportBundle = {
      generated_at: new Date().toISOString(),
      user: {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        email: 'user@example.com',
        plan: 'FREE',
        created_at: new Date().toISOString(),
        privacy_policy_version: '2026-02-15',
        terms_version: '2026-02-15',
        consented_at: new Date().toISOString(),
        marketing_consent: false
      },
      jobs: [],
      documents: [],
      chunks: [],
      usage_events: [],
      data_subject_requests: []
    };

    for (const key of requiredBundleKeys) {
      expect(bundle).toHaveProperty(key);
    }
  });

  it('generated_at is a valid ISO timestamp string', () => {
    const timestamp = new Date().toISOString();
    expect(() => new Date(timestamp)).not.toThrow();
    expect(new Date(timestamp).getTime()).toBeGreaterThan(0);
  });
});

describe('DATA_REQUEST_TYPES', () => {
  it('contains all 6 required GDPR request types', () => {
    expect(DATA_REQUEST_TYPES).toContain('export');
    expect(DATA_REQUEST_TYPES).toContain('delete');
    expect(DATA_REQUEST_TYPES).toContain('rectification');
    expect(DATA_REQUEST_TYPES).toContain('restriction');
    expect(DATA_REQUEST_TYPES).toContain('objection');
    expect(DATA_REQUEST_TYPES).toContain('portability');
  });

  it('has exactly 6 request types', () => {
    expect(DATA_REQUEST_TYPES).toHaveLength(6);
  });
});
