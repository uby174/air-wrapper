import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicProvider,
  executeWithFallback,
  GoogleProvider,
  OpenAIProvider,
  type EmbedParams,
  type GenerateTextParams,
  type LLMProvider
} from '../index';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

describe('provider adapters', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('OpenAIProvider returns generateText + embed response shape', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: 'openai reply' } }],
          usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            { embedding: [0.1, 0.2, 0.3] },
            { embedding: [0.4, 0.5, 0.6] }
          ]
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider({ apiKey: 'test-openai-key' });

    const generateInput: GenerateTextParams = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }]
    };
    const embedInput: EmbedParams = {
      model: 'text-embedding-3-small',
      inputs: ['a', 'b']
    };

    const textResult = await provider.generateText(generateInput);
    const embedResult = await provider.embed(embedInput);

    expect(textResult).toEqual({
      text: 'openai reply',
      usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 }
    });
    expect(embedResult.vectors).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6]
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('AnthropicProvider returns generateText + embed response shape', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: 'text', text: 'anthropic reply' }],
          usage: { input_tokens: 8, output_tokens: 2 }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            { embedding: [1, 2, 3] },
            { embedding: [4, 5, 6] }
          ]
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({ apiKey: 'test-anthropic-key' });

    const textResult = await provider.generateText({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hello' }]
    });
    const embedResult = await provider.embed({
      model: 'claude-embed-test',
      inputs: ['x', 'y']
    });

    expect(textResult).toEqual({
      text: 'anthropic reply',
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: undefined }
    });
    expect(embedResult.vectors).toEqual([
      [1, 2, 3],
      [4, 5, 6]
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('GoogleProvider returns generateText + embed response shape', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          candidates: [{ content: { parts: [{ text: 'google reply' }] } }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, totalTokenCount: 12 }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          embeddings: [{ values: [0.9, 0.1] }, { values: [0.8, 0.2] }]
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GoogleProvider({ apiKey: 'test-google-key' });

    const textResult = await provider.generateText({
      model: 'gemini-test',
      messages: [{ role: 'user', content: 'hey' }]
    });
    const embedResult = await provider.embed({
      model: 'gemini-embedding-001',
      inputs: ['chunk-1', 'chunk-2']
    });

    expect(textResult).toEqual({
      text: 'google reply',
      usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 }
    });
    expect(embedResult.vectors).toEqual([
      [0.9, 0.1],
      [0.8, 0.2]
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('executeWithFallback', () => {
  it('uses the next provider when the first one throws', async () => {
    const first: LLMProvider = {
      name: 'openai',
      generateText: vi.fn().mockRejectedValue(new Error('primary failed')),
      embed: vi.fn().mockResolvedValue({ vectors: [[0.1]] })
    };
    const second: LLMProvider = {
      name: 'anthropic',
      generateText: vi.fn().mockResolvedValue({ text: 'fallback reply', usage: { inputTokens: 1 } }),
      embed: vi.fn().mockResolvedValue({ vectors: [[0.2]] })
    };

    const logger = vi.fn();

    const result = await executeWithFallback(
      {
        action: 'generateText',
        input: {
          model: 'model-x',
          messages: [{ role: 'user', content: 'message' }]
        },
        providers: {
          openai: first,
          anthropic: second
        },
        logger
      },
      ['openai', 'anthropic']
    );

    expect(result.provider).toBe('anthropic');
    expect(result.result).toEqual({ text: 'fallback reply', usage: { inputTokens: 1 } });
    expect(first.generateText).toHaveBeenCalledTimes(1);
    expect(second.generateText).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        model: 'model-x',
        status: null
      })
    );
  });
});
