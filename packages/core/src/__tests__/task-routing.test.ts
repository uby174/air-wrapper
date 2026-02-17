import { describe, expect, it, vi } from 'vitest';
import { classifyTask, estimateCost, routeModel, type PriceTable, type TaskType } from '../index';

interface SamplePrompt {
  prompt: string;
  expected: TaskType;
}

const samplePrompts: SamplePrompt[] = [
  { prompt: 'Translate this sentence to Spanish: I am on my way.', expected: 'SIMPLE' },
  { prompt: 'Spell check this line: We recieved your mesage.', expected: 'SIMPLE' },
  { prompt: 'Fix punctuation: hello how are you', expected: 'SIMPLE' },
  { prompt: 'Format this JSON for readability {"a":1,"b":[2,3]}', expected: 'SIMPLE' },
  { prompt: 'What is the capital of Japan?', expected: 'SIMPLE' },
  { prompt: 'Who is Ada Lovelace?', expected: 'SIMPLE' },
  { prompt: 'When is leap day?', expected: 'SIMPLE' },
  { prompt: 'Where is the Eiffel Tower?', expected: 'SIMPLE' },
  { prompt: 'Define recursion.', expected: 'SIMPLE' },
  { prompt: 'Rephrase this: We appreciate your quick response.', expected: 'SIMPLE' },
  { prompt: 'Paraphrase this sentence in plain English.', expected: 'SIMPLE' },
  { prompt: 'Proofread this text for grammar only.', expected: 'SIMPLE' },
  { prompt: 'Translation request: convert this to Hindi.', expected: 'SIMPLE' },
  { prompt: 'Basic Q&A: what is photosynthesis?', expected: 'SIMPLE' },
  { prompt: 'Format this markdown into bullet points.', expected: 'SIMPLE' },
  { prompt: 'Summarize this article into 5 bullets.', expected: 'MEDIUM' },
  { prompt: 'Compare React and Vue for a startup MVP.', expected: 'MEDIUM' },
  { prompt: 'Draft a polite follow-up email for a job application.', expected: 'MEDIUM' },
  { prompt: 'Extract all invoice numbers from this text block.', expected: 'MEDIUM' },
  { prompt: 'Explain this code snippet and suggest small improvements.', expected: 'MEDIUM' },
  { prompt: 'Create an outline for a 10 minute presentation on cloud security.', expected: 'MEDIUM' },
  { prompt: 'Summarise the transcript and list key action items.', expected: 'MEDIUM' },
  { prompt: 'Classify these customer comments by sentiment.', expected: 'MEDIUM' },
  { prompt: 'Refactor this function for readability.', expected: 'MEDIUM' },
  { prompt: 'Draft release notes from these git commits.', expected: 'MEDIUM' },
  { prompt: 'Compare these two vendor proposals and provide pros and cons.', expected: 'MEDIUM' },
  { prompt: 'Build a study plan for the next two weeks with daily tasks.', expected: 'MEDIUM' },
  { prompt: 'Explain trade settlement in simple terms for beginners.', expected: 'MEDIUM' },
  { prompt: 'Summarize and rewrite this blog post intro.', expected: 'MEDIUM' },
  { prompt: 'Draft a customer apology email after a minor outage.', expected: 'MEDIUM' },
  {
    prompt: 'Design a multi-step migration strategy from monolith to microservices with rollback plans.',
    expected: 'COMPLEX'
  },
  {
    prompt: 'Create a system design for a globally distributed chat application with 10M DAU.',
    expected: 'COMPLEX'
  },
  {
    prompt: 'Write a detailed threat model for our payment API and prioritize mitigations.',
    expected: 'COMPLEX'
  },
  {
    prompt: 'Prepare an incident response plan for a production outage caused by cascading failures.',
    expected: 'COMPLEX'
  },
  {
    prompt: 'Build a 12 month AI product roadmap with milestones, risks, and trade-offs.',
    expected: 'COMPLEX'
  },
  {
    prompt: 'Generate a research report with methodology and references on EV battery recycling.',
    expected: 'COMPLEX'
  },
  {
    prompt: 'Provide a legal risk analysis for operating a fintech app in multiple countries.',
    expected: 'COMPLEX'
  },
  {
    prompt: 'Create a medical triage assistant policy with safety constraints and escalation logic.',
    expected: 'COMPLEX'
  },
  {
    prompt:
      'Develop an end-to-end architecture for data ingestion, streaming analytics, and real-time alerting at scale.',
    expected: 'COMPLEX'
  },
  {
    prompt: 'Evaluate and optimize our cloud cost strategy across three regions and multiple workloads.',
    expected: 'COMPLEX'
  },
  {
    prompt: 'Design a compliance program for SOC 2 and ISO 27001 with implementation phases.',
    expected: 'COMPLEX'
  },
  {
    prompt: 'Produce a comprehensive strategy to enter two new markets with pricing experiments.',
    expected: 'COMPLEX'
  },
  {
    prompt: 'Create a deep technical plan for scaling our search pipeline to billions of documents.',
    expected: 'COMPLEX'
  },
  {
    prompt: 'Design a high-availability architecture with RTO and RPO targets for disaster recovery.',
    expected: 'COMPLEX'
  },
  {
    prompt: 'Build a financial model with multiple scenarios for a subscription SaaS business.',
    expected: 'COMPLEX'
  },
  { prompt: 'Translate this to French and fix any spelling errors.', expected: 'SIMPLE' },
  { prompt: 'What is DNS?', expected: 'SIMPLE' },
  { prompt: 'Draft a short project update email for stakeholders.', expected: 'MEDIUM' },
  { prompt: 'Explain this SQL query and propose one optimization.', expected: 'MEDIUM' },
  {
    prompt: 'Create an architecture decision record for moving to event-driven systems.',
    expected: 'COMPLEX'
  }
];

describe('classifyTask', () => {
  it('categorizes 50 sample prompts correctly', async () => {
    expect(samplePrompts).toHaveLength(50);

    for (const sample of samplePrompts) {
      const result = await classifyTask(sample.prompt);
      expect(result, sample.prompt).toBe(sample.expected);
    }
  });

  it('uses layer-2 classifier callback for ambiguous prompts', async () => {
    const classifier = vi.fn().mockResolvedValue('COMPLEX');

    const result = await classifyTask('Help me with this task please.', {
      classifyAmbiguous: classifier
    });

    expect(result).toBe('COMPLEX');
    expect(classifier).toHaveBeenCalledTimes(1);
  });

  it('falls back deterministically when layer-2 classifier errors', async () => {
    const classifier = vi.fn().mockRejectedValue(new Error('classifier unavailable'));

    const result = await classifyTask('Can you plan my onboarding communication for next week?', {
      classifyAmbiguous: classifier
    });

    expect(result).toBe('MEDIUM');
    expect(classifier).toHaveBeenCalledTimes(1);
  });
});

describe('routeModel', () => {
  it('returns deterministic route decisions', () => {
    const firstSimple = routeModel('SIMPLE');
    const firstMedium = routeModel('MEDIUM');
    const firstComplex = routeModel('COMPLEX');

    for (let i = 0; i < 25; i += 1) {
      expect(routeModel('SIMPLE')).toEqual(firstSimple);
      expect(routeModel('MEDIUM')).toEqual(firstMedium);
      expect(routeModel('COMPLEX')).toEqual(firstComplex);
    }
  });

  it('matches default routing tiers', () => {
    expect(routeModel('SIMPLE')).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      maxTokens: 400,
      cacheable: true
    });
    expect(routeModel('MEDIUM')).toEqual({
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
      maxTokens: 900,
      cacheable: false
    });
    expect(routeModel('COMPLEX')).toEqual({
      provider: 'google',
      model: 'gemini-pro-latest',
      maxTokens: 1800,
      cacheable: false
    });
  });
});

describe('estimateCost', () => {
  const priceTable: PriceTable = {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6
  };

  it('calculates cost from input and output tokens', () => {
    const cost = estimateCost(
      {
        inputTokens: 1200,
        outputTokens: 800
      },
      priceTable
    );
    expect(cost).toBe(0.00066);
  });

  it('uses total tokens when split token metrics are missing', () => {
    const cost = estimateCost(
      {
        totalTokens: 1000
      },
      priceTable
    );
    expect(cost).toBe(0.000285);
  });
});
