// SPDX-License-Identifier: Apache-2.0

import { logger } from '../../../utils/logger.js';
import {
  ServerClassifiedProviderError,
  parseRetryAfterMs,
} from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

const OPENAI_RESPONSES_API_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5';

export interface CodexObservationProviderOptions {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

interface OpenAIResponsesResponse {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: { type?: string; message?: string };
}

export class CodexObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'codex' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CodexObservationProviderOptions) {
    if (!options.apiKey) {
      throw new ServerClassifiedProviderError('Codex API key not configured', {
        kind: 'auth_invalid',
        cause: new Error('apiKey is required'),
      });
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
    this.apiUrl = options.apiUrl ?? OPENAI_RESPONSES_API_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
  ): Promise<ServerGenerationResult> {
    const { prompt, skippedAll } = buildServerGenerationPrompt(context);
    if (skippedAll) {
      // All events were scrubbed by privacy stripping. Don't bill the
      // provider — return a synthetic skip response that parser accepts.
      return {
        rawText: '<skip_summary reason="all_events_private" />',
        providerLabel: this.providerLabel,
        modelId: this.model,
      };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: prompt,
          max_output_tokens: this.maxOutputTokens,
        }),
        signal,
      });
    } catch (networkError) {
      throw classifyCodexServerError({
        cause: networkError,
      });
    }

    if (!response.ok) {
      const bodyText = await safeReadBody(response);
      throw classifyCodexServerError({
        status: response.status,
        bodyText,
        headers: response.headers,
        cause: new Error(`Codex API error: ${response.status} - ${bodyText}`),
      });
    }

    let data: OpenAIResponsesResponse;
    try {
      data = (await response.json()) as OpenAIResponsesResponse;
    } catch (parseError) {
      throw new ServerClassifiedProviderError('Codex returned invalid JSON', {
        kind: 'parse_error',
        cause: parseError,
      });
    }

    if (data.error) {
      throw classifyCodexServerError({
        status: response.status,
        bodyText: `${data.error.type ?? ''} ${data.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`Codex API error: ${data.error.type} - ${data.error.message}`),
      });
    }

    const contentBlocks = (Array.isArray(data.output) ? data.output : [])
      .flatMap(item => Array.isArray(item.content) ? item.content : []);
    const rawText = (typeof data.output_text === 'string' ? data.output_text : '') || contentBlocks
      .filter(block => block?.type === 'output_text' && typeof block.text === 'string')
      .map(block => block.text!)
      .join('\n')
      .trim();

    if (!rawText) {
      logger.warn('SDK', 'Codex returned empty response output', {
        provider: 'codex',
        model: this.model,
      });
    }

    const usage = data.usage ?? {};
    const tokensUsed =
      typeof usage.total_tokens === 'number'
        ? usage.total_tokens
        : typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number'
        ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
        : undefined;

    return {
      rawText,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      providerLabel: this.providerLabel,
      modelId: this.model,
    };
  }
}

interface ClassifyInput {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
}

/**
 * Codex-specific HTTP error classification. Mirrors worker
 * `classifyCodexError`, but extracted for server-beta and rebound to
 * OpenAI Responses API semantics rather than Codex CLI process errors.
 */
export function classifyCodexServerError(input: ClassifyInput): ServerClassifiedProviderError {
  const status = input.status;
  const body = input.bodyText ?? '';
  const lower = body.toLowerCase();
  const retryAfterMs = input.headers ? parseRetryAfterMs(input.headers.get('retry-after')) : undefined;

  if (lower.includes('overloaded')) {
    return new ServerClassifiedProviderError(
      `Codex overloaded${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'transient', cause: input.cause },
    );
  }

  if (status === 401 || status === 403 || lower.includes('invalid api key')) {
    return new ServerClassifiedProviderError(
      `Codex auth invalid${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'auth_invalid', cause: input.cause },
    );
  }

  if (status === 429) {
    return new ServerClassifiedProviderError('Codex rate limit (429)', {
      kind: 'rate_limit',
      cause: input.cause,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  if (lower.includes('quota exceeded')) {
    return new ServerClassifiedProviderError('Codex quota exhausted', {
      kind: 'quota_exhausted',
      cause: input.cause,
    });
  }

  if (
    lower.includes('prompt is too long') ||
    lower.includes('context window') ||
    lower.includes('max_tokens')
  ) {
    return new ServerClassifiedProviderError('Codex context overflow', {
      kind: 'unrecoverable',
      cause: input.cause,
    });
  }

  if (status === 529) {
    return new ServerClassifiedProviderError('Codex overloaded (529)', {
      kind: 'transient',
      cause: input.cause,
    });
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ServerClassifiedProviderError(`Codex upstream error (status ${status})`, {
      kind: 'transient',
      cause: input.cause,
    });
  }

  if (status === 400) {
    return new ServerClassifiedProviderError('Codex bad request (400)', {
      kind: 'unrecoverable',
      cause: input.cause,
    });
  }

  if (status === undefined) {
    const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
    return new ServerClassifiedProviderError(`Codex network error: ${message}`, {
      kind: 'transient',
      cause: input.cause,
    });
  }

  return new ServerClassifiedProviderError(
    `Codex API error: ${status}${body ? ` - ${body.substring(0, 200)}` : ''}`,
    { kind: 'unrecoverable', cause: input.cause },
  );
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
