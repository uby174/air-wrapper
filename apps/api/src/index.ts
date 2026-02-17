import { serve } from '@hono/node-server';
import { zValidator } from '@hono/zod-validator';
import {
  applyGuardrails,
  baseSystemPrompt,
  cacheKeyForChat,
  classifyTask,
  estimateCost,
  getMemoryCache,
  routeModel,
  routes,
  setMemoryCache,
  type PriceTable,
  type ProviderName,
  type TaskType
} from '@ai-wrapper/core';
import { AnthropicProvider, GoogleProvider, OpenAIProvider, type LLMProvider, type ProviderUsage } from '@ai-wrapper/providers';
import { chunkText, fakeEmbedding, retrieveTopK, type Chunk } from '@ai-wrapper/rag';
import { chatRequestSchema, healthSchema } from '@ai-wrapper/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { authMiddleware, type ApiVariables } from './auth/middleware';
import { createJobRecord, getJobRecordForUser, listRecentJobs, markJobFailed } from './db/jobs';
import { writeAuditEvent } from './db/audit';
import {
  createDataSubjectRequest,
  DATA_REQUEST_TYPES,
  deleteUserAndCascadeData,
  exportUserDataBundle,
  getPrivacyStatus,
  getRetentionConfig,
  runRetentionCleanup,
  updateUserConsent
} from './db/privacy';
import { type UserPlan, updateUserPlan, upsertUserByEmail } from './db/users';
import { writeUsageEvent } from './db/usage-events';
import { enqueueAiJob, startAiJobsWorker } from './jobs/queue';
import { createJobRequestSchema, type PersistedJobInput } from './jobs/types';
import { minimizeJobInputForStorage } from './privacy/data-minimization';
import { consumeDailyJobQuota } from './rate-limit';
import { signJwtToken } from './auth/jwt';

const app = new Hono<{ Variables: ApiVariables }>();

const port = Number(process.env.PORT ?? 8787);
const privacyPolicyVersion = process.env.PRIVACY_POLICY_VERSION?.trim() || '2026-02-15';
const termsVersion = process.env.TERMS_VERSION?.trim() || '2026-02-15';

const parseCsv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const parseBool = (value: string | undefined, fallback = false): boolean => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

const corsOrigins = parseCsv(process.env.CORS_ALLOW_ORIGINS);
const requirePrivacyConsent = parseBool(process.env.REQUIRE_PRIVACY_CONSENT, true);

const providers: Partial<Record<ProviderName, LLMProvider>> = {};
const openAiApiKey = process.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_API?.trim();
const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_API?.trim();
const googleApiKey = process.env.GOOGLE_API_KEY?.trim() || process.env.GOOGLE_API?.trim();

if (openAiApiKey) {
  providers.openai = new OpenAIProvider({ apiKey: openAiApiKey });
}

if (anthropicApiKey) {
  providers.anthropic = new AnthropicProvider({ apiKey: anthropicApiKey });
}

if (googleApiKey) {
  providers.google = new GoogleProvider({ apiKey: googleApiKey });
}

const MODEL_BY_TASK_AND_PROVIDER: Record<TaskType, Record<ProviderName, string>> = {
  SIMPLE: {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-haiku-latest',
    google: 'gemini-flash-latest'
  },
  MEDIUM: {
    openai: 'gpt-4.1-mini',
    anthropic: 'claude-3-5-haiku-latest',
    google: 'gemini-pro-latest'
  },
  COMPLEX: {
    openai: 'gpt-4.1',
    anthropic: 'claude-3-5-sonnet-latest',
    google: 'gemini-pro-latest'
  }
};

const PRICE_TABLE_BY_PROVIDER: Record<ProviderName, PriceTable> = {
  openai: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  anthropic: { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  google: { inputPerMillion: 0.1, outputPerMillion: 0.3 }
};

const PROVIDER_FALLBACK_ORDER: ProviderName[] = ['openai', 'anthropic', 'google'];

const parseTaskType = (raw: string): TaskType | null => {
  const matched = raw.toUpperCase().match(/\b(SIMPLE|MEDIUM|COMPLEX)\b/);
  if (!matched) return null;
  return matched[1] as TaskType;
};

const approximateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

const resolveUsageTokens = (
  usage: ProviderUsage | undefined,
  requestText: string,
  responseText: string
): { inputTokens: number; outputTokens: number } => {
  const inputTokens = usage?.inputTokens ?? approximateTokens(requestText);
  const outputTokens = usage?.outputTokens ?? approximateTokens(responseText);

  if (!usage?.inputTokens && !usage?.outputTokens && usage?.totalTokens) {
    const weightedInput = Math.round(usage.totalTokens * 0.7);
    return {
      inputTokens: weightedInput,
      outputTokens: Math.max(usage.totalTokens - weightedInput, 0)
    };
  }

  return { inputTokens, outputTokens };
};

const uniqueProviders = (providersInput: ProviderName[]): ProviderName[] => Array.from(new Set(providersInput));

const selectProviderForTask = (taskType: TaskType, requestedProvider: ProviderName): ProviderName | null => {
  const routed = routeModel(taskType).provider;
  const candidates = uniqueProviders([routed, requestedProvider, ...PROVIDER_FALLBACK_ORDER]);
  return candidates.find((provider) => Boolean(providers[provider])) ?? null;
};

const classifyAmbiguousTask = async (input: string): Promise<TaskType | null> => {
  const classifierOrder = uniqueProviders(['openai', 'google', 'anthropic']);
  const systemPrompt =
    'Classify user request complexity. Output only one token: SIMPLE, MEDIUM, or COMPLEX.';

  for (const providerName of classifierOrder) {
    const provider = providers[providerName];
    if (!provider) continue;

    const classifierModel = MODEL_BY_TASK_AND_PROVIDER.SIMPLE[providerName];

    try {
      const result = await provider.generateText({
        model: classifierModel,
        maxTokens: 16,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: input }
        ]
      });

      const parsed = parseTaskType(result.text);
      if (parsed) return parsed;
    } catch (error) {
      console.error({
        scope: 'task_classifier',
        provider: providerName,
        status: error instanceof Error ? error.message : 'Unknown classifier error'
      });
    }
  }

  return null;
};

const safeWriteUsageEvent = async (params: {
  userId: string;
  useCase: string;
  tokensIn: number;
  tokensOut: number;
  costEstimate: number;
}): Promise<void> => {
  try {
    await writeUsageEvent({
      userId: params.userId,
      useCase: params.useCase,
      tokensIn: params.tokensIn,
      tokensOut: params.tokensOut,
      costEstimate: params.costEstimate
    });
  } catch (error) {
    console.error({
      scope: 'usage_events',
      useCase: params.useCase,
      error: error instanceof Error ? error.message : 'Unknown usage-event error'
    });
  }
};

// Demo in-memory corpus for retrieval helper. Replace with pgvector retrieval in production.
const corpusChunks: Chunk[] = chunkText(
  'AI Wrapper provides provider-agnostic routing, guardrails, and RAG retrieval. ' +
    'Use pgvector in production for semantic search.'
).map((text, idx) => ({
  id: `seed-${idx}`,
  text,
  embedding: fakeEmbedding(text)
}));

if (process.env.DISABLE_AI_JOBS_WORKER !== 'true') {
  startAiJobsWorker();
}

if (parseBool(process.env.PRIVACY_RETENTION_RUN_ON_STARTUP, true)) {
  void runRetentionCleanup()
    .then((outcome) => {
      console.info({
        scope: 'privacy_retention',
        trigger: 'startup',
        ...outcome
      });
    })
    .catch((error) => {
      console.error({
        scope: 'privacy_retention',
        trigger: 'startup',
        error: error instanceof Error ? error.message : 'Unknown retention cleanup error'
      });
    });
}

app.use(
  '*',
  cors({
    origin: corsOrigins.length === 0 ? '*' : corsOrigins,
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-admin-token']
  })
);

app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Cache-Control', 'no-store');
  await next();
});

app.get(routes.health, (c) => c.json(healthSchema.parse({ ok: true, service: 'api' })));

const devLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});
const enableDevAuth = process.env.ENABLE_DEV_AUTH === 'true' || process.env.NODE_ENV !== 'production';

app.post('/v1/auth/dev-login', zValidator('json', devLoginSchema), async (c) => {
  if (!enableDevAuth) {
    return c.json({ error: 'Dev auth is disabled.' }, 404);
  }

  const jwtSecret = process.env.AUTH_JWT_SECRET?.trim();
  if (!jwtSecret) {
    return c.json({ error: 'Server JWT auth is not configured. Set AUTH_JWT_SECRET.' }, 500);
  }

  const payload = c.req.valid('json');
  const user = await upsertUserByEmail(payload.email);
  const tokenTtl = Number(process.env.DEV_AUTH_TOKEN_TTL_SEC ?? '86400');
  const token = signJwtToken(
    {
      user_id: user.id,
      email: user.email
    },
    jwtSecret,
    tokenTtl
  );

  return c.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      plan: user.plan
    }
  });

  void writeAuditEvent({
    userId: user.id,
    action: 'auth.dev_login.success',
    metadata: {
      enableDevAuth
    }
  }).catch(() => {
    // Non-blocking audit event.
  });
});

app.use('/v1/*', authMiddleware);

const jobParamSchema = z.object({
  id: z.string().uuid()
});

const jobListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const userPlanSchema = z.enum(['FREE', 'PRO', 'BUSINESS']);
const adminUserParamSchema = z.object({
  id: z.string().uuid()
});
const adminPlanUpdateSchema = z.object({
  plan: userPlanSchema
});
const privacyConsentSchema = z.object({
  privacyPolicyVersion: z.string().min(1).max(100).default(privacyPolicyVersion),
  termsVersion: z.string().min(1).max(100).optional(),
  marketingConsent: z.boolean().optional()
});
const privacyRequestSchema = z.object({
  requestType: z.enum(DATA_REQUEST_TYPES),
  note: z.string().max(1000).optional()
});

app.post(
  '/v1/admin/users/:id/plan',
  zValidator('param', adminUserParamSchema),
  zValidator('json', adminPlanUpdateSchema),
  async (c) => {
    const configuredAdminToken = process.env.ADMIN_API_TOKEN?.trim();
    const providedAdminToken = c.req.header('x-admin-token')?.trim();

    if (!configuredAdminToken) {
      return c.json({ error: 'Server admin API token is not configured. Set ADMIN_API_TOKEN.' }, 500);
    }

    if (!providedAdminToken || providedAdminToken !== configuredAdminToken) {
      return c.json({ error: 'Forbidden. Missing or invalid x-admin-token.' }, 403);
    }

    const params = c.req.valid('param');
    const body = c.req.valid('json');
    const updated = await updateUserPlan({
      userId: params.id,
      plan: body.plan as UserPlan
    });

    if (!updated) {
      return c.json({ error: `User ${params.id} not found.` }, 404);
    }

    void writeAuditEvent({
      userId: params.id,
      action: 'admin.user_plan.updated',
      metadata: {
        plan: updated.plan
      }
    }).catch(() => {
      // Non-blocking audit event.
    });

    return c.json({
      id: updated.id,
      email: updated.email,
      plan: updated.plan,
      created_at: updated.created_at
    });
  }
);

app.post('/v1/admin/privacy/retention-run', async (c) => {
  const configuredAdminToken = process.env.ADMIN_API_TOKEN?.trim();
  const providedAdminToken = c.req.header('x-admin-token')?.trim();

  if (!configuredAdminToken) {
    return c.json({ error: 'Server admin API token is not configured. Set ADMIN_API_TOKEN.' }, 500);
  }

  if (!providedAdminToken || providedAdminToken !== configuredAdminToken) {
    return c.json({ error: 'Forbidden. Missing or invalid x-admin-token.' }, 403);
  }

  const outcome = await runRetentionCleanup();
  const retentionConfig = getRetentionConfig();

  void writeAuditEvent({
    action: 'admin.privacy.retention_run',
    metadata: {
      retentionConfig,
      outcome
    }
  }).catch(() => {
    // Non-blocking audit event.
  });

  return c.json({
    retentionConfig,
    outcome
  });
});

app.get('/v1/privacy/me/status', async (c) => {
  const authUser = c.get('authUser');
  const status = await getPrivacyStatus(authUser.userId);
  if (!status) {
    return c.json({ error: 'User not found.' }, 404);
  }

  return c.json({
    user: {
      id: status.id,
      email: status.email,
      plan: status.plan,
      created_at: status.created_at
    },
    consent: {
      privacy_policy_version: status.privacy_policy_version,
      terms_version: status.terms_version,
      consented_at: status.consented_at,
      marketing_consent: status.marketing_consent
    },
    retention: getRetentionConfig()
  });
});

app.post('/v1/privacy/me/consent', zValidator('json', privacyConsentSchema), async (c) => {
  const authUser = c.get('authUser');
  const payload = c.req.valid('json');

  const updated = await updateUserConsent({
    userId: authUser.userId,
    privacyPolicyVersion: payload.privacyPolicyVersion,
    termsVersion: payload.termsVersion ?? termsVersion,
    marketingConsent: payload.marketingConsent
  });

  await createDataSubjectRequest({
    userId: authUser.userId,
    requestType: 'rectification',
    status: 'completed',
    note: `Consent updated to policy=${updated.privacy_policy_version} terms=${updated.terms_version}`
  });

  void writeAuditEvent({
    userId: authUser.userId,
    action: 'privacy.consent.updated',
    metadata: {
      privacyPolicyVersion: updated.privacy_policy_version,
      termsVersion: updated.terms_version,
      marketingConsent: updated.marketing_consent
    }
  }).catch(() => {
    // Non-blocking audit event.
  });

  return c.json({
    consented_at: updated.consented_at,
    privacy_policy_version: updated.privacy_policy_version,
    terms_version: updated.terms_version,
    marketing_consent: updated.marketing_consent
  });
});

app.post('/v1/privacy/me/request', zValidator('json', privacyRequestSchema), async (c) => {
  const authUser = c.get('authUser');
  const payload = c.req.valid('json');
  const created = await createDataSubjectRequest({
    userId: authUser.userId,
    requestType: payload.requestType,
    note: payload.note ?? null,
    status: 'open'
  });

  void writeAuditEvent({
    userId: authUser.userId,
    action: 'privacy.request.created',
    metadata: {
      requestId: created.id,
      requestType: created.request_type
    }
  }).catch(() => {
    // Non-blocking audit event.
  });

  return c.json({
    id: created.id,
    request_type: created.request_type,
    status: created.status,
    created_at: created.created_at
  });
});

app.get('/v1/privacy/me/export', async (c) => {
  const authUser = c.get('authUser');
  const bundle = await exportUserDataBundle(authUser.userId);

  await createDataSubjectRequest({
    userId: authUser.userId,
    requestType: 'export',
    status: 'completed',
    note: 'Self-service export generated via API.'
  });

  void writeAuditEvent({
    userId: authUser.userId,
    action: 'privacy.export.generated',
    metadata: {
      jobs: bundle.jobs.length,
      documents: bundle.documents.length,
      chunks: bundle.chunks.length,
      usageEvents: bundle.usage_events.length
    }
  }).catch(() => {
    // Non-blocking audit event.
  });

  c.header(
    'Content-Disposition',
    `attachment; filename="ai-wrapper-user-export-${authUser.userId}-${new Date().toISOString().slice(0, 10)}.json"`
  );

  return c.json(bundle);
});

app.delete('/v1/privacy/me', async (c) => {
  const authUser = c.get('authUser');
  const result = await deleteUserAndCascadeData({
    userId: authUser.userId,
    reason: 'user_requested_api_delete'
  });

  void writeAuditEvent({
    userId: authUser.userId,
    action: 'privacy.account.deleted',
    metadata: {
      deleted: result.deleted
    }
  }).catch(() => {
    // Non-blocking audit event.
  });

  return c.json(
    {
      deleted: result.deleted,
      message: 'Account and related data deletion has been executed. Re-authentication is required.'
    },
    result.deleted ? 200 : 404
  );
});

app.post('/v1/jobs', zValidator('json', createJobRequestSchema), async (c) => {
  const authUser = c.get('authUser');
  const payload = c.req.valid('json');

  if (requirePrivacyConsent) {
    const privacyStatus = await getPrivacyStatus(authUser.userId);
    if (!privacyStatus?.consented_at) {
      return c.json(
        {
          error: 'Privacy consent is required before creating jobs. Call POST /v1/privacy/me/consent first.'
        },
        412
      );
    }
  }

  const quota = await consumeDailyJobQuota({
    userId: authUser.userId,
    plan: authUser.plan
  });

  if (!quota.allowed) {
    await safeWriteUsageEvent({
      userId: authUser.userId,
      useCase: `rate_limit_jobs_${payload.use_case}`,
      tokensIn: 0,
      tokensOut: 0,
      costEstimate: 0
    });

    return c.json(
      {
        error: `Daily job limit reached for ${quota.plan} plan (${quota.limit}/day). Resets at ${quota.resetAt}.`
      },
      429
    );
  }

  const persistedInput: PersistedJobInput = {
    input: minimizeJobInputForStorage(payload.input),
    options: payload.options
  };

  const row = await createJobRecord({
    userId: authUser.userId,
    useCase: payload.use_case,
    input: persistedInput
  });

  try {
    await enqueueAiJob({
      dbJobId: row.id,
      runtimeInput: payload.input,
      timeoutMs: payload.options?.timeoutMs
    });
  } catch (error) {
    await markJobFailed(row.id, error instanceof Error ? error.message : 'Failed to enqueue job');
    await safeWriteUsageEvent({
      userId: authUser.userId,
      useCase: `job_create_failed_${payload.use_case}`,
      tokensIn: 0,
      tokensOut: 0,
      costEstimate: 0
    });
    return c.json({ error: 'Failed to enqueue job' }, 500);
  }

  await safeWriteUsageEvent({
    userId: authUser.userId,
    useCase: `job_create_${payload.use_case}`,
    tokensIn: 0,
    tokensOut: 0,
    costEstimate: 0
  });

  void writeAuditEvent({
    userId: authUser.userId,
    action: 'jobs.create',
    metadata: {
      jobId: row.id,
      useCase: payload.use_case,
      inputType: payload.input.type
    }
  }).catch(() => {
    // Non-blocking audit event.
  });

  return c.json(
    {
      id: row.id,
      status: row.status,
      remainingToday: quota.remaining
    },
    202
  );
});

app.get('/v1/jobs/:id', zValidator('param', jobParamSchema), async (c) => {
  const authUser = c.get('authUser');
  const params = c.req.valid('param');
  const row = await getJobRecordForUser({
    jobId: params.id,
    userId: authUser.userId
  });

  if (!row) {
    return c.json({ error: 'Job not found' }, 404);
  }

  return c.json({
    id: row.id,
    use_case: row.use_case,
    status: row.status,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at
  });
});

app.get('/v1/jobs/:id/result', zValidator('param', jobParamSchema), async (c) => {
  const authUser = c.get('authUser');
  const params = c.req.valid('param');
  const row = await getJobRecordForUser({
    jobId: params.id,
    userId: authUser.userId
  });

  if (!row) {
    return c.json({ error: 'Job not found' }, 404);
  }

  if (row.status === 'succeeded') {
    return c.json({
      id: row.id,
      status: row.status,
      result: row.result,
      citations: row.citations
    });
  }

  if (row.status === 'failed') {
    return c.json(
      {
        id: row.id,
        status: row.status,
        error: row.error
      },
      409
    );
  }

  return c.json(
    {
      id: row.id,
      status: row.status
    },
    202
  );
});

app.get('/v1/jobs', zValidator('query', jobListQuerySchema), async (c) => {
  const authUser = c.get('authUser');
  const queryParams = c.req.valid('query');
  const limit = queryParams.limit ?? 20;
  const rows = await listRecentJobs({
    userId: authUser.userId,
    limit
  });

  return c.json({
    items: rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      use_case: row.use_case,
      status: row.status,
      error: row.error,
      created_at: row.created_at,
      updated_at: row.updated_at
    }))
  });
});

app.post(routes.chat, zValidator('json', chatRequestSchema), async (c) => {
  const authUser = c.get('authUser');
  const payload = c.req.valid('json');

  if (requirePrivacyConsent) {
    const privacyStatus = await getPrivacyStatus(authUser.userId);
    if (!privacyStatus?.consented_at) {
      return c.json(
        {
          error: 'Privacy consent is required before using chat. Call POST /v1/privacy/me/consent first.'
        },
        412
      );
    }
  }

  const clean = applyGuardrails(payload.message);
  const taskType = await classifyTask(clean, { classifyAmbiguous: classifyAmbiguousTask });
  const route = routeModel(taskType);
  const providerName = selectProviderForTask(taskType, payload.provider);
  const key = cacheKeyForChat({ provider: route.provider, message: clean });

  if (!providerName) {
    await safeWriteUsageEvent({
      userId: authUser.userId,
      useCase: `chat_${taskType.toLowerCase()}_unavailable`,
      tokensIn: 0,
      tokensOut: 0,
      costEstimate: 0
    });

    return c.json(
      {
        error: 'No AI provider is configured. Add at least one provider API key in apps/api/.env.'
      },
      503
    );
  }

  if (route.cacheable) {
    const hit = getMemoryCache(key);
    if (hit) {
      await safeWriteUsageEvent({
        userId: authUser.userId,
        useCase: `chat_${taskType.toLowerCase()}_cached`,
        tokensIn: 0,
        tokensOut: 0,
        costEstimate: 0
      });

      return c.json({ reply: hit, provider: route.provider, cached: true });
    }
  }

  const queryEmbedding = fakeEmbedding(clean);
  const context = retrieveTopK(queryEmbedding, corpusChunks, 2)
    .map((chunk) => `- ${chunk.text}`)
    .join('\n');

  const generationOrder = uniqueProviders([providerName, ...PROVIDER_FALLBACK_ORDER]);
  let result: Awaited<ReturnType<LLMProvider['generateText']>> | null = null;
  let resolvedProviderName: ProviderName | null = null;

  for (const candidateProviderName of generationOrder) {
    const candidateProvider = providers[candidateProviderName];
    if (!candidateProvider) continue;

    const model = MODEL_BY_TASK_AND_PROVIDER[taskType][candidateProviderName];

    try {
      result = await candidateProvider.generateText({
        model,
        maxTokens: route.maxTokens,
        temperature: taskType === 'SIMPLE' ? 0.2 : taskType === 'MEDIUM' ? 0.4 : 0.5,
        messages: [
          { role: 'system', content: `${baseSystemPrompt}\n\nContext:\n${context}` },
          { role: 'user', content: clean }
        ]
      });
      resolvedProviderName = candidateProviderName;
      break;
    } catch (error) {
      console.error({
        scope: 'chat_generation',
        provider: candidateProviderName,
        model,
        status:
          typeof error === 'object' && error !== null && 'status' in error
            ? (error as { status?: unknown }).status
            : null,
        error: error instanceof Error ? error.message : 'Unknown provider generation error'
      });
    }
  }

  if (!result || !resolvedProviderName) {
    await safeWriteUsageEvent({
      userId: authUser.userId,
      useCase: `chat_${taskType.toLowerCase()}_failed`,
      tokensIn: approximateTokens(clean),
      tokensOut: 0,
      costEstimate: 0
    });

    return c.json({ error: 'All configured providers failed to generate a response.' }, 502);
  }

  const reply = result.text || 'No response from provider.';
  const requestText = `${baseSystemPrompt}\n${context}\n${clean}`;
  const usage = resolveUsageTokens(result.usage, requestText, reply);
  const costEstimate = estimateCost(usage, PRICE_TABLE_BY_PROVIDER[resolvedProviderName]);

  await safeWriteUsageEvent({
    userId: authUser.userId,
    useCase: `chat_${taskType.toLowerCase()}`,
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    costEstimate
  });

  if (route.cacheable) {
    setMemoryCache(key, reply, 20_000);
  }

  return c.json({ reply, provider: resolvedProviderName, cached: false });
});

serve(
  {
    fetch: app.fetch,
    port
  },
  (info) => {
    console.log(`API running on http://localhost:${info.port}`);
  }
);
