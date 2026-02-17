import { createJobRecord, getJobRecord } from '../db/jobs';
import { resolveDefaultUsageUserId } from '../db/usage-events';
import { enqueueAiJob, startAiJobsWorker } from './queue';
import type { PersistedJobInput } from './types';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitForTerminalStatus = async (jobId: string, timeoutMs = 240_000): Promise<string> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const job = await getJobRecord(jobId);
    if (!job) throw new Error(`Job ${jobId} was not found`);
    if (job.status === 'succeeded' || job.status === 'failed') return job.status;
    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for job ${jobId}`);
};

const main = async (): Promise<void> => {
  startAiJobsWorker();
  const userId = await resolveDefaultUsageUserId();

  const ids: string[] = [];
  const seedJobs: Array<{ useCase: string; text: string }> = [
    {
      useCase: 'legal_contract_analysis',
      text: 'Review this contract excerpt and identify risky indemnity and termination clauses.'
    },
    {
      useCase: 'medical_research_summary',
      text: 'Summarize this meta-analysis on cardiovascular outcomes and list key limitations.'
    },
    {
      useCase: 'financial_report_analysis',
      text: 'Analyze this quarterly report and highlight material risk flags and notable metrics.'
    },
    {
      useCase: 'legal_contract_analysis',
      text: 'Assess obligations and renewal terms in this services agreement.'
    },
    {
      useCase: 'financial_report_analysis',
      text: 'Explain year-over-year revenue, margin changes, and risks from the filing notes.'
    }
  ];

  for (let i = 0; i < seedJobs.length; i += 1) {
    const seed = seedJobs[i];
    const persisted: PersistedJobInput = {
      input: {
        type: 'text',
        text: `Sequential smoke job ${i + 1}: ${seed.text}`
      },
      options: {
        timeoutMs: 120_000
      }
    };

    const row = await createJobRecord({
      userId,
      useCase: seed.useCase,
      input: persisted
    });

    await enqueueAiJob({
      dbJobId: row.id,
      timeoutMs: persisted.options?.timeoutMs
    });

    ids.push(row.id);
  }

  for (const id of ids) {
    const status = await waitForTerminalStatus(id);
    console.log(`Job ${id} finished with status: ${status}`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
