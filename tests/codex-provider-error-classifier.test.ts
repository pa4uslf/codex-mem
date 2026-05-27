import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';

import {
  classifyCodexError,
  __resetEffortHintLatchForTesting,
} from '../src/services/worker/CodexProvider.js';
import { isClassified } from '../src/services/worker/provider-errors.js';
import { logger } from '../src/utils/logger.js';

/**
 * Tests for HTTP 400 classification in CodexProvider's classifyCodexError.
 *
 * Regression coverage for #2357: CodexProvider previously had no explicit
 * HTTP 400 handling, so the default branch classified all 400s as `transient`
 * and the retry loop would hammer a permanent error indefinitely (e.g. when
 * CODEX_CODE_EFFORT_LEVEL leaks into the SDK subprocess and the model
 * rejects the `effort` parameter).
 */
describe('classifyCodexError — HTTP 400 handling (#2357)', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    __resetEffortHintLatchForTesting();
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    __resetEffortHintLatchForTesting();
  });

  it('classifies 400 with "effort parameter" body as unrecoverable AND logs an SDK warn once', () => {
    const sdkErr = Object.assign(
      new Error('This model does not support the effort parameter.'),
      { status: 400 },
    );

    const classified = classifyCodexError(sdkErr);

    expect(isClassified(classified)).toBe(true);
    expect(classified.kind).toBe('unrecoverable');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // First positional arg of logger.warn is the component category.
    const [component, hintMessage] = warnSpy.mock.calls[0] as [string, string, ...unknown[]];
    expect(component).toBe('SDK');
    expect(hintMessage).toMatch(/effort/i);
    expect(hintMessage).toMatch(/2357/);
  });

  it('classifies 400 with effort marker in a structured body field', () => {
    const sdkErr = Object.assign(
      new Error('Bad request'),
      {
        status: 400,
        body: { error: { message: 'This model does not support the effort parameter.' } },
      },
    );

    const classified = classifyCodexError(sdkErr);

    expect(classified.kind).toBe('unrecoverable');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('classifies 400 without effort body as unrecoverable WITHOUT firing the effort hint', () => {
    const sdkErr = Object.assign(
      new Error('some other 400 error'),
      { status: 400 },
    );

    const classified = classifyCodexError(sdkErr);

    expect(classified.kind).toBe('unrecoverable');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('throttles the effort hint to one log per process even on repeated 400s', () => {
    const sdkErr = Object.assign(
      new Error('This model does not support the effort parameter.'),
      { status: 400 },
    );

    for (let i = 0; i < 5; i++) {
      const classified = classifyCodexError(sdkErr);
      expect(classified.kind).toBe('unrecoverable');
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('classifyCodexError — sibling status codes (regression sanity)', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    __resetEffortHintLatchForTesting();
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    __resetEffortHintLatchForTesting();
  });

  it('classifies status=401 as auth_invalid', () => {
    const sdkErr = Object.assign(new Error('unauthorized'), { status: 401 });
    const classified = classifyCodexError(sdkErr);
    expect(classified.kind).toBe('auth_invalid');
  });

  it('classifies status=429 as rate_limit', () => {
    const sdkErr = Object.assign(new Error('rate limited'), { status: 429 });
    const classified = classifyCodexError(sdkErr);
    expect(classified.kind).toBe('rate_limit');
  });

  it('classifies a network error with no status as transient', () => {
    const networkErr = new Error('ECONNRESET: socket hang up');
    const classified = classifyCodexError(networkErr);
    expect(classified.kind).toBe('transient');
  });
});
