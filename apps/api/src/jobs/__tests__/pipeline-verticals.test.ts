import { beforeEach, describe, expect, it, vi } from 'vitest';

const getJobRecordMock = vi.fn();
const markJobSucceededMock = vi.fn();
const writeUsageEventMock = vi.fn();
const writeAuditEventMock = vi.fn();
const generateTextMock = vi.fn();
const chunkTextMock = vi.fn();
const embedChunksMock = vi.fn();
const upsertDocumentMock = vi.fn();
const retrieveTopKMock = vi.fn();
const buildContextMock = vi.fn();

vi.mock('../../db/jobs', () => ({
  getJobRecord: getJobRecordMock,
  markJobSucceeded: markJobSucceededMock
}));

vi.mock('../../db/usage-events', () => ({
  writeUsageEvent: writeUsageEventMock
}));

vi.mock('../../db/audit', () => ({
  writeAuditEvent: writeAuditEventMock
}));

vi.mock('../../db/client', () => ({
  query: vi.fn().mockResolvedValue([])
}));

vi.mock('../pdf', () => ({
  extractTextFromPdfUrl: vi.fn().mockResolvedValue('Mock PDF text')
}));

vi.mock('@ai-wrapper/rag', () => ({
  chunkText: chunkTextMock,
  embedChunks: embedChunksMock,
  upsertDocument: upsertDocumentMock,
  retrieveTopK: retrieveTopKMock,
  buildContext: buildContextMock
}));

buildContextMock.mockReturnValue({
  context: '',
  citations: []
});

retrieveTopKMock.mockResolvedValue([]);
chunkTextMock.mockReturnValue([
  {
    chunk_text: 'Mock chunk text',
    chunk_order: 0,
    metadata: {
      source: 'inline:text',
      chunk_order: 0
    }
  }
]);
embedChunksMock.mockResolvedValue([
  {
    chunk_text: 'Mock chunk text',
    chunk_order: 0,
    metadata: {
      source: 'inline:text',
      chunk_order: 0
    },
    embedding: [0.1, 0.2, 0.3]
  }
]);
upsertDocumentMock.mockResolvedValue('doc-1');

class MockProvider {
  constructor(_config: { apiKey: string }) {}

  async generateText(params: { messages: Array<{ content: string }> }): Promise<{
    text: string;
    usage: { inputTokens: number; outputTokens: number };
  }> {
    return generateTextMock(params);
  }
}

vi.mock('@ai-wrapper/providers', () => ({
  OpenAIProvider: MockProvider,
  AnthropicProvider: MockProvider,
  GoogleProvider: MockProvider
}));

const baseJobRecord = {
  id: 'e7f71340-5d5e-44e0-9e75-b901a4e355aa',
  user_id: '6f4b7f5a-078f-4883-9f1a-5e3ad5f1be4f',
  status: 'queued',
  result: {},
  citations: [],
  error: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

const verticalFixtures = [
  {
    useCase: 'legal_contract_analysis',
    input: 'Review these indemnity and termination clauses.',
    expectedKey: 'summary',
    response: {
      summary: 'Contract has moderate termination risk.',
      key_risks: [{ clause: 'Termination', risk_level: 'medium', explanation: 'Broad unilateral right.' }],
      obligations: ['Give 30-day notice'],
      recommendations: ['Narrow termination triggers'],
      disclaimer: 'This is an AI analysis and not legal advice.'
    }
  },
  {
    useCase: 'medical_research_summary',
    input: 'Summarize findings and limitations in this clinical trial.',
    expectedKey: 'research_question',
    response: {
      research_question: 'Does intervention X reduce endpoint Y?',
      evidence_summary: 'Evidence suggests a modest effect with caveats.',
      key_findings: ['Primary endpoint improved'],
      limitations: ['Small sample size'],
      safety_notes: ['Monitor adverse effects'],
      not_medical_advice: true
    }
  },
  {
    useCase: 'financial_report_analysis',
    input: 'Analyze quarterly performance and risk factors.',
    expectedKey: 'executive_summary',
    response: {
      executive_summary: 'Revenue grew but margin pressure increased.',
      key_metrics: [{ metric: 'Revenue', value: '$10M', interpretation: 'Up 8% YoY' }],
      risk_flags: ['Rising COGS'],
      recommendations: ['Monitor margin trend'],
      disclaimer: 'This analysis is informational and not investment advice.'
    }
  }
] as const;

describe('processAiJob vertical pipeline', () => {
  beforeEach(() => {
    vi.resetModules();
    getJobRecordMock.mockReset();
    markJobSucceededMock.mockReset();
    writeUsageEventMock.mockReset();
    writeAuditEventMock.mockReset();
    generateTextMock.mockReset();
    chunkTextMock.mockReset();
    embedChunksMock.mockReset();
    upsertDocumentMock.mockReset();
    retrieveTopKMock.mockReset();
    buildContextMock.mockReset();
    buildContextMock.mockReturnValue({
      context: '',
      citations: []
    });
    retrieveTopKMock.mockResolvedValue([]);
    chunkTextMock.mockReturnValue([
      {
        chunk_text: 'Mock chunk text',
        chunk_order: 0,
        metadata: {
          source: 'inline:text',
          chunk_order: 0
        }
      }
    ]);
    embedChunksMock.mockResolvedValue([
      {
        chunk_text: 'Mock chunk text',
        chunk_order: 0,
        metadata: {
          source: 'inline:text',
          chunk_order: 0
        },
        embedding: [0.1, 0.2, 0.3]
      }
    ]);
    upsertDocumentMock.mockResolvedValue('doc-1');
    process.env.OPENAI_API_KEY = 'test-openai-key';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  it.each(verticalFixtures)('processes %s end-to-end via vertical config', async (fixture) => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify(fixture.response),
      usage: { inputTokens: 120, outputTokens: 80 }
    });

    getJobRecordMock.mockResolvedValue({
      ...baseJobRecord,
      use_case: fixture.useCase,
      input: {
        input: {
          type: 'text',
          text: fixture.input
        },
        options: {
          rag: {
            enabled: false
          }
        }
      }
    });

    const { processAiJob } = await import('../pipeline');
    await processAiJob({ dbJobId: baseJobRecord.id });

    expect(generateTextMock.mock.calls.length).toBeGreaterThan(0);
    expect(markJobSucceededMock).toHaveBeenCalledTimes(1);
    expect(writeUsageEventMock).toHaveBeenCalledTimes(1);

    const [, persistedResult] = markJobSucceededMock.mock.calls[0] ?? [];
    expect(persistedResult).toHaveProperty(fixture.expectedKey);
  });

  it('continues job execution when RAG embedding fails', async () => {
    const fixture = verticalFixtures[0];
    generateTextMock.mockResolvedValue({
      text: JSON.stringify(fixture.response),
      usage: { inputTokens: 120, outputTokens: 80 }
    });
    embedChunksMock.mockRejectedValue(new Error('Embedding provider unavailable'));

    getJobRecordMock.mockResolvedValue({
      ...baseJobRecord,
      use_case: fixture.useCase,
      input: {
        input: {
          type: 'text',
          text: fixture.input
        },
        options: {
          rag: {
            enabled: true,
            storeInputAsDocs: true,
            topK: 6
          }
        }
      }
    });

    const { processAiJob } = await import('../pipeline');
    await expect(processAiJob({ dbJobId: baseJobRecord.id })).resolves.toBeUndefined();

    expect(embedChunksMock).toHaveBeenCalledTimes(1);
    expect(markJobSucceededMock).toHaveBeenCalledTimes(1);
    expect(writeUsageEventMock).toHaveBeenCalledTimes(1);
  });

  it('coerces non-JSON model output into schema-compatible result', async () => {
    generateTextMock
      .mockResolvedValueOnce({
        text: 'High-level analysis: termination is broad and indemnity is asymmetric.',
        usage: { inputTokens: 90, outputTokens: 30 }
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          summary: 'Termination is broad and indemnity is asymmetric.',
          key_risks: [{ clause: 'Not provided', risk_level: 'high', explanation: 'Broad termination and indemnity exposure.' }],
          obligations: [],
          recommendations: [{ action: 'Narrow termination triggers', rationale: 'Reduce unilateral termination risk', priority: 'high' }],
          missingInfo: ['governingLaw'],
          confidence: { overall: 'medium', reasons: ['Only high-level text provided'] },
          metadata: { useCaseKey: 'legal_contract_analysis', createdAt: new Date().toISOString() },
          governingLaw: 'Not provided',
          jurisdiction: 'Not provided',
          disputeResolution: 'Not provided',
          liabilityCap: 'Not provided'
        }),
        usage: { inputTokens: 120, outputTokens: 80 }
      });

    getJobRecordMock.mockResolvedValue({
      ...baseJobRecord,
      use_case: 'legal_contract_analysis',
      input: {
        input: {
          type: 'text',
          text: 'Analyze termination and indemnity clauses.'
        },
        options: {
          rag: {
            enabled: false
          }
        }
      }
    });

    const { processAiJob } = await import('../pipeline');
    await expect(processAiJob({ dbJobId: baseJobRecord.id })).resolves.toBeUndefined();

    expect(markJobSucceededMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const [, persistedResult] = markJobSucceededMock.mock.calls[0] ?? [];
    expect(persistedResult).toMatchObject({
      summary: expect.any(String),
      key_risks: expect.any(Array),
      obligations: expect.any(Array),
      recommendations: expect.any(Array),
      disclaimer: expect.any(String)
    });
  });

  it('unwraps nested fenced JSON inside summary into structured legal fields', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        summary: [
          '```json',
          '{"summary":"Clean summary","key_risks":[{"clause":"AVB 2.5","risk_level":"high","explanation":"Coverage can lapse after default."}],',
          '"obligations":["Pay premium on time"],"recommendations":["Set autopay"],"disclaimer":"Custom disclaimer"}',
          '```'
        ].join('\n'),
        key_risks: [],
        obligations: [],
        recommendations: [],
        disclaimer: 'This is an AI analysis and not legal advice.'
      }),
      usage: { inputTokens: 120, outputTokens: 80 }
    });

    getJobRecordMock.mockResolvedValue({
      ...baseJobRecord,
      use_case: 'legal_contract_analysis',
      input: {
        input: {
          type: 'text',
          text: 'Analyze legal risks in this policy contract.'
        },
        options: {
          rag: {
            enabled: false
          }
        }
      }
    });

    const { processAiJob } = await import('../pipeline');
    await expect(processAiJob({ dbJobId: baseJobRecord.id })).resolves.toBeUndefined();

    const [, persistedResult] = markJobSucceededMock.mock.calls[0] ?? [];
    expect(persistedResult).toMatchObject({
      summary: 'Clean summary',
      obligations: ['Pay premium on time'],
      disclaimer: 'This is an AI analysis and not legal advice.'
    });
    expect((persistedResult as { recommendations: Array<{ action: string }> }).recommendations[0]?.action).toBe(
      'Set autopay'
    );
    expect(Array.isArray((persistedResult as { key_risks?: unknown[] }).key_risks)).toBe(true);
    expect((persistedResult as { key_risks: unknown[] }).key_risks.length).toBe(1);
  });

  it('extracts legal fields from malformed json-like summary text', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        summary: [
          '```json',
          '{"summary":"Recovered summary","key_risks":[{"clause":"AHB 6.3","risk_level":"high","explanation":"Coverage may end after breach."}],',
          '"obligations":["Provide accurate disclosures"],"recommendations":["Review termination clause"],"disclaimer":"Recovered disclaimer"',
          '```'
        ].join('\n'),
        key_risks: [],
        obligations: [],
        recommendations: [],
        disclaimer: ''
      }),
      usage: { inputTokens: 120, outputTokens: 80 }
    });

    getJobRecordMock.mockResolvedValue({
      ...baseJobRecord,
      use_case: 'legal_contract_analysis',
      input: {
        input: {
          type: 'text',
          text: 'Analyze default and disclosure duties.'
        },
        options: {
          rag: {
            enabled: false
          }
        }
      }
    });

    const { processAiJob } = await import('../pipeline');
    await expect(processAiJob({ dbJobId: baseJobRecord.id })).resolves.toBeUndefined();

    const [, persistedResult] = markJobSucceededMock.mock.calls[0] ?? [];
    expect(persistedResult).toMatchObject({
      summary: 'Recovered summary',
      obligations: ['Provide accurate disclosures'],
      disclaimer: 'This is an AI analysis and not legal advice.'
    });
    expect((persistedResult as { recommendations: Array<{ action: string }> }).recommendations[0]?.action).toBe(
      'Review termination clause'
    );
    expect(Array.isArray((persistedResult as { key_risks?: unknown[] }).key_risks)).toBe(true);
    expect((persistedResult as { key_risks: unknown[] }).key_risks.length).toBe(1);
  });

  it('extracts summary from truncated json-like summary text without closing quote', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        summary: [
          '```json',
          '{',
          '  "summary": "Analysis of default and disclosure duties in the contract',
          '```'
        ].join('\n'),
        key_risks: [],
        obligations: [],
        recommendations: [],
        disclaimer: ''
      }),
      usage: { inputTokens: 80, outputTokens: 20 }
    });

    getJobRecordMock.mockResolvedValue({
      ...baseJobRecord,
      use_case: 'legal_contract_analysis',
      input: {
        input: {
          type: 'text',
          text: 'Analyze contract duties.'
        },
        options: {
          rag: {
            enabled: false
          }
        }
      }
    });

    const { processAiJob } = await import('../pipeline');
    await expect(processAiJob({ dbJobId: baseJobRecord.id })).resolves.toBeUndefined();

    const [, persistedResult] = markJobSucceededMock.mock.calls[0] ?? [];
    expect(persistedResult).toMatchObject({
      summary: 'Analysis of default and disclosure duties in the contract',
      disclaimer: 'This is an AI analysis and not legal advice.'
    });
  });

  it('extracts financial fields from nested json-like executive_summary text', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        executive_summary: [
          '```json',
          '{"executive_summary":"Revenue grew while margins compressed.","key_metrics":[{"metric":"Revenue","value":"$10.2B","interpretation":"Up 12% YoY"}],',
          '"risk_flags":["Margin compression"],"recommendations":["Reduce operating costs"],"disclaimer":"Finance disclaimer"}',
          '```'
        ].join('\n'),
        key_metrics: [],
        risk_flags: [],
        recommendations: [],
        disclaimer: ''
      }),
      usage: { inputTokens: 120, outputTokens: 80 }
    });

    getJobRecordMock.mockResolvedValue({
      ...baseJobRecord,
      use_case: 'financial_report_analysis',
      input: {
        input: {
          type: 'text',
          text: 'Compare quarterly revenue and margin changes.'
        },
        options: {
          rag: {
            enabled: false
          }
        }
      }
    });

    const { processAiJob } = await import('../pipeline');
    await expect(processAiJob({ dbJobId: baseJobRecord.id })).resolves.toBeUndefined();

    const [, persistedResult] = markJobSucceededMock.mock.calls[0] ?? [];
    expect(persistedResult).toMatchObject({
      executive_summary: 'Revenue grew while margins compressed.',
      risk_flags: ['Margin compression'],
      disclaimer: 'This analysis is informational and not investment advice.'
    });
    expect((persistedResult as { recommendations: Array<{ action: string }> }).recommendations[0]?.action).toBe(
      'Reduce operating costs'
    );
    expect(Array.isArray((persistedResult as { key_metrics?: unknown[] }).key_metrics)).toBe(true);
    expect((persistedResult as { key_metrics: unknown[] }).key_metrics.length).toBe(1);
  });

  it('applies financial maxTokens floor to reduce truncation risk', async () => {
    let capturedMaxTokens: number | undefined;
    generateTextMock.mockImplementation(async (params: { maxTokens?: number }) => {
      capturedMaxTokens = params.maxTokens;
      return {
        text: JSON.stringify({
          executive_summary: 'Complete financial summary.',
          key_metrics: [{ metric: 'Revenue', value: '$10.2B', interpretation: 'Up 12% YoY' }],
          risk_flags: ['Margin pressure'],
          recommendations: ['Improve cost controls'],
          disclaimer: 'This analysis is informational and not investment advice.'
        }),
        usage: { inputTokens: 90, outputTokens: 50 }
      };
    });

    getJobRecordMock.mockResolvedValue({
      ...baseJobRecord,
      use_case: 'financial_report_analysis',
      input: {
        input: {
          type: 'text',
          text: 'Compare quarterly performance and provide recommendations.'
        },
        options: {
          rag: {
            enabled: false
          }
        }
      }
    });

    const { processAiJob } = await import('../pipeline');
    await expect(processAiJob({ dbJobId: baseJobRecord.id })).resolves.toBeUndefined();

    expect(capturedMaxTokens).toBeDefined();
    expect(capturedMaxTokens).toBeGreaterThanOrEqual(2200);
  });

  it('applies a second-pass enrichment when legal output is sparse for long inputs', async () => {
    const longLegalInput = `legal contract analysis ${'payment-default disclosure termination indemnity '.repeat(20)}`;

    generateTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          summary: 'Initial sparse summary only.',
          key_risks: [],
          obligations: [],
          recommendations: [],
          disclaimer: 'This is an AI analysis and not legal advice.'
        }),
        usage: { inputTokens: 120, outputTokens: 40 }
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          summary: 'Enriched legal summary with concrete risk analysis.',
          key_risks: [
            {
              clause: 'Payment default clause',
              risk_level: 'high',
              explanation: 'Coverage may lapse quickly after non-payment.'
            }
          ],
          obligations: ['Pay premiums before due dates'],
          recommendations: ['Set automated payment reminders'],
          disclaimer: 'This is an AI analysis and not legal advice.'
        }),
        usage: { inputTokens: 150, outputTokens: 90 }
      });

    getJobRecordMock.mockResolvedValue({
      ...baseJobRecord,
      use_case: 'legal_contract_analysis',
      input: {
        input: {
          type: 'text',
          text: longLegalInput
        },
        options: {
          rag: {
            enabled: false
          }
        }
      }
    });

    const { processAiJob } = await import('../pipeline');
    await expect(processAiJob({ dbJobId: baseJobRecord.id })).resolves.toBeUndefined();

    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(markJobSucceededMock).toHaveBeenCalledTimes(1);

    const [, persistedResult] = markJobSucceededMock.mock.calls[0] ?? [];
    expect((persistedResult as { key_risks: unknown[] }).key_risks.length).toBeGreaterThan(0);
    expect((persistedResult as { obligations: unknown[] }).obligations.length).toBeGreaterThan(0);
    expect((persistedResult as { recommendations: unknown[] }).recommendations.length).toBeGreaterThan(0);
  });

  it('extracts medical fields from nested json-like evidence_summary text', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        evidence_summary: [
          '```json',
          '{"research_question":"Does intervention X improve endpoint Y?","evidence_summary":"Intervention X shows moderate benefit.",',
          '"key_findings":["Primary endpoint improved"],"limitations":["Small sample size"],"safety_notes":["Monitor liver enzymes"]}',
          '```'
        ].join('\n'),
        key_findings: [],
        limitations: [],
        safety_notes: []
      }),
      usage: { inputTokens: 110, outputTokens: 70 }
    });

    getJobRecordMock.mockResolvedValue({
      ...baseJobRecord,
      use_case: 'medical_research_summary',
      input: {
        input: {
          type: 'text',
          text: 'Summarize evidence and limitations for this trial.'
        },
        options: {
          rag: {
            enabled: false
          }
        }
      }
    });

    const { processAiJob } = await import('../pipeline');
    await expect(processAiJob({ dbJobId: baseJobRecord.id })).resolves.toBeUndefined();

    const [, persistedResult] = markJobSucceededMock.mock.calls[0] ?? [];
    expect(persistedResult).toMatchObject({
      research_question: 'Does intervention X improve endpoint Y?',
      evidence_summary: 'Intervention X shows moderate benefit.',
      key_findings: ['Primary endpoint improved'],
      limitations: ['Small sample size'],
      safety_notes: ['Monitor liver enzymes'],
      not_medical_advice: true
    });
  });

  it('applies a second-pass enrichment when medical output is sparse for long inputs', async () => {
    const longMedicalInput = `medical research summary ${'randomized trial sample size endpoints confidence interval '.repeat(18)}`;

    generateTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          research_question: 'Initial research question.',
          evidence_summary: 'Initial sparse summary only.',
          key_findings: [],
          limitations: [],
          safety_notes: [],
          not_medical_advice: true
        }),
        usage: { inputTokens: 120, outputTokens: 40 }
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          research_question: 'Does intervention improve primary outcome?',
          evidence_summary: 'The trial suggests moderate efficacy with notable caveats.',
          key_findings: ['Primary outcome improved', 'Secondary endpoint mixed'],
          limitations: ['Small sample', 'Short follow-up'],
          safety_notes: ['Monitor adverse events', 'Drug interactions remain uncertain'],
          not_medical_advice: true
        }),
        usage: { inputTokens: 170, outputTokens: 110 }
      });

    getJobRecordMock.mockResolvedValue({
      ...baseJobRecord,
      use_case: 'medical_research_summary',
      input: {
        input: {
          type: 'text',
          text: longMedicalInput
        },
        options: {
          rag: {
            enabled: false
          }
        }
      }
    });

    const { processAiJob } = await import('../pipeline');
    await expect(processAiJob({ dbJobId: baseJobRecord.id })).resolves.toBeUndefined();

    expect(generateTextMock).toHaveBeenCalledTimes(2);
    const [, persistedResult] = markJobSucceededMock.mock.calls[0] ?? [];
    expect((persistedResult as { key_findings: unknown[] }).key_findings.length).toBeGreaterThan(0);
    expect((persistedResult as { limitations: unknown[] }).limitations.length).toBeGreaterThan(0);
    expect((persistedResult as { safety_notes: unknown[] }).safety_notes.length).toBeGreaterThan(0);
  });

  it('retries once to fix invalid structured JSON, audits failures, and throws structured 502 payload if still invalid', async () => {
    generateTextMock
      .mockResolvedValueOnce({
        text: '{"foo":"bar"}',
        usage: { inputTokens: 120, outputTokens: 20 }
      })
      .mockResolvedValueOnce({
        text: '{"still":"invalid"}',
        usage: { inputTokens: 80, outputTokens: 20 }
      })
      .mockResolvedValue({
        text: '{"still":"invalid"}',
        usage: { inputTokens: 80, outputTokens: 20 }
      });

    getJobRecordMock.mockResolvedValue({
      ...baseJobRecord,
      use_case: 'legal_contract_analysis',
      input: {
        input: {
          type: 'text',
          text: 'Review the indemnity clause.'
        },
        options: {
          rag: {
            enabled: false
          }
        }
      }
    });

    const { processAiJob } = await import('../pipeline');
    await expect(processAiJob({ dbJobId: baseJobRecord.id })).rejects.toThrow('STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED');

    expect(generateTextMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(writeAuditEventMock).toHaveBeenCalledTimes(2);
    expect(markJobSucceededMock).not.toHaveBeenCalled();

    const retryCallArgs = generateTextMock.mock.calls[generateTextMock.mock.calls.length - 1]?.[0] as
      | { messages: Array<{ content: string }> }
      | undefined;
    const retryPrompt = retryCallArgs?.messages.map((m) => m.content).join('\n\n') ?? '';
    expect(retryPrompt).toContain('Return ONLY corrected JSON matching the schema; no extra text.');
  });
});
