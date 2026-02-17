import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { markJobFailed, markJobQueued, markJobRunning } from '../db/jobs';
import { aiJobQueuePayloadSchema, type AiJobQueuePayload } from './types';
import { processAiJob } from './pipeline';

const queueName = process.env.JOB_QUEUE_NAME?.trim() || 'ai-jobs';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const jobAttempts = Number(process.env.JOB_ATTEMPTS ?? '3');
const defaultTimeoutMs = Number(process.env.JOB_TIMEOUT_MS ?? '120000');
const workerConcurrency = Number(process.env.JOB_WORKER_CONCURRENCY ?? '1');

const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null
});

export const aiJobsQueue = new Queue<AiJobQueuePayload>(queueName, {
  connection,
  defaultJobOptions: {
    attempts: Math.max(1, jobAttempts),
    backoff: {
      type: 'exponential',
      delay: 1_000
    },
    removeOnComplete: 1000,
    removeOnFail: 1000
  }
});

let aiJobsWorker: Worker<AiJobQueuePayload, void> | null = null;

const withTimeout = async <T>(work: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Job timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const enqueueAiJob = async (payloadRaw: AiJobQueuePayload): Promise<void> => {
  const payload = aiJobQueuePayloadSchema.parse(payloadRaw);

  const jobOptions: JobsOptions = {
    jobId: payload.dbJobId
  };

  await aiJobsQueue.add('execute', payload, jobOptions);
};

export const startAiJobsWorker = (): Worker<AiJobQueuePayload, void> => {
  if (aiJobsWorker) {
    return aiJobsWorker;
  }

  aiJobsWorker = new Worker<AiJobQueuePayload, void>(
    queueName,
    async (job) => {
      const payload = aiJobQueuePayloadSchema.parse(job.data);
      const timeoutMs = Math.max(1_000, payload.timeoutMs ?? defaultTimeoutMs);
      await withTimeout(processAiJob(payload), timeoutMs);
    },
    {
      connection,
      concurrency: Math.max(1, workerConcurrency)
    }
  );

  aiJobsWorker.on('active', async (job: Job<AiJobQueuePayload, void, string>) => {
    const payload = aiJobQueuePayloadSchema.parse(job.data);
    await markJobRunning(payload.dbJobId).catch((error) =>
      console.error({
        scope: 'ai_jobs_worker_active',
        jobId: payload.dbJobId,
        error: error instanceof Error ? error.message : 'Unknown active handler error'
      })
    );
  });

  aiJobsWorker.on('failed', async (job: Job<AiJobQueuePayload, void, string> | undefined, error: Error) => {
    if (!job) return;
    const payload = aiJobQueuePayloadSchema.parse(job.data);
    const attemptsAllowed = job.opts.attempts ?? Math.max(1, jobAttempts);
    const shouldRetry = job.attemptsMade < attemptsAllowed;

    if (shouldRetry) {
      await markJobQueued(
        payload.dbJobId,
        `Retrying after failure (${job.attemptsMade}/${attemptsAllowed}): ${
          error?.message ?? 'Unknown worker error'
        }`
      ).catch((statusError: unknown) =>
        console.error({
          scope: 'ai_jobs_worker_retry_status',
          jobId: payload.dbJobId,
          error: statusError instanceof Error ? statusError.message : 'Unknown retry status error'
        })
      );
      return;
    }

    await markJobFailed(payload.dbJobId, error?.message ?? 'Job execution failed').catch((statusError: unknown) =>
      console.error({
        scope: 'ai_jobs_worker_failed_status',
        jobId: payload.dbJobId,
        error: statusError instanceof Error ? statusError.message : 'Unknown failed status error'
      })
    );
  });

  aiJobsWorker.on('error', (error: Error) => {
    console.error({
      scope: 'ai_jobs_worker_runtime',
      error: error instanceof Error ? error.message : 'Unknown worker runtime error'
    });
  });

  return aiJobsWorker;
};

export const closeAiJobsInfra = async (): Promise<void> => {
  await aiJobsWorker?.close();
  await aiJobsQueue.close();
  await connection.quit();
  aiJobsWorker = null;
};
