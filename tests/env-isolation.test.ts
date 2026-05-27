import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  envFilePath,
  buildIsolatedEnv,
  buildIsolatedEnvWithFreshOAuth,
} from '../src/shared/EnvManager.js';
import * as oauthToken from '../src/shared/oauth-token.js';

/**
 * Tests for issue #2375: CODEX_BASE_URL must not leak from the parent
 * shell into the spawned worker's isolatedEnv, AND the OAuth-skip predicate
 * must not inject the user's Codex OAuth token onto a custom gateway URL
 * (which would be a token leak to a third party).
 *
 * Redirect EnvManager to a per-suite temp file via CODEX_MEM_ENV_FILE so
 * the user's real ~/.codex-mem/.env is never read or mutated even if a test
 * fails mid-flight. envFilePath() resolves the override on every call, so
 * this works regardless of the order other tests imported the module.
 */

const TEST_DATA_DIR = fs.mkdtempSync(join(tmpdir(), 'codex-mem-env-isolation-'));
const TEST_ENV_FILE = join(TEST_DATA_DIR, '.env');
const ORIGINAL_ENV_FILE = process.env.CODEX_MEM_ENV_FILE;

const ORIGINAL_BASE_URL = process.env.CODEX_BASE_URL;
const ORIGINAL_API_KEY = process.env.CODEX_API_KEY;
const ORIGINAL_AUTH_TOKEN = process.env.CODEX_AUTH_TOKEN;
const ORIGINAL_OAUTH_TOKEN = process.env.CODEX_CODE_OAUTH_TOKEN;

function clearEnvFile(): void {
  if (fs.existsSync(TEST_ENV_FILE)) {
    fs.unlinkSync(TEST_ENV_FILE);
  }
}

function clearCodexEnv(): void {
  delete process.env.CODEX_BASE_URL;
  delete process.env.CODEX_API_KEY;
  delete process.env.CODEX_AUTH_TOKEN;
  delete process.env.CODEX_CODE_OAUTH_TOKEN;
}

function restoreOriginalEnv(): void {
  if (ORIGINAL_BASE_URL === undefined) {
    delete process.env.CODEX_BASE_URL;
  } else {
    process.env.CODEX_BASE_URL = ORIGINAL_BASE_URL;
  }
  if (ORIGINAL_API_KEY === undefined) {
    delete process.env.CODEX_API_KEY;
  } else {
    process.env.CODEX_API_KEY = ORIGINAL_API_KEY;
  }
  if (ORIGINAL_AUTH_TOKEN === undefined) {
    delete process.env.CODEX_AUTH_TOKEN;
  } else {
    process.env.CODEX_AUTH_TOKEN = ORIGINAL_AUTH_TOKEN;
  }
  if (ORIGINAL_OAUTH_TOKEN === undefined) {
    delete process.env.CODEX_CODE_OAUTH_TOKEN;
  } else {
    process.env.CODEX_CODE_OAUTH_TOKEN = ORIGINAL_OAUTH_TOKEN;
  }
}

describe('Issue #2375: CODEX_BASE_URL env-var isolation', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true, mode: 0o700 });
    process.env.CODEX_MEM_ENV_FILE = TEST_ENV_FILE;
    expect(envFilePath()).toBe(TEST_ENV_FILE);
  });

  afterAll(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    if (ORIGINAL_ENV_FILE === undefined) {
      delete process.env.CODEX_MEM_ENV_FILE;
    } else {
      process.env.CODEX_MEM_ENV_FILE = ORIGINAL_ENV_FILE;
    }
  });

  beforeEach(() => {
    clearEnvFile();
    clearCodexEnv();
  });

  afterEach(() => {
    clearEnvFile();
    restoreOriginalEnv();
  });

  it('leaked CODEX_BASE_URL is stripped from isolatedEnv', () => {
    // No .env file exists. The parent shell sets a stray CODEX_BASE_URL —
    // this MUST NOT propagate into the subprocess isolatedEnv, because doing
    // so used to trigger the OAuth-skip path and leave the worker with no
    // credentials at all.
    process.env.CODEX_BASE_URL = 'https://shouldnotleak.example';

    const result = buildIsolatedEnv();

    expect(result.CODEX_BASE_URL).toBeUndefined();
  });

  it('~/.codex-mem/.env BASE_URL + AUTH_TOKEN reaches isolatedEnv', () => {
    // User intentionally configured a gateway with a gateway-appropriate
    // auth token. Both must be re-injected into isolatedEnv.
    fs.writeFileSync(
      TEST_ENV_FILE,
      'CODEX_BASE_URL=https://gateway.example\nCODEX_AUTH_TOKEN=test-token\n',
      { mode: 0o600 },
    );

    const result = buildIsolatedEnv();

    expect(result.CODEX_BASE_URL).toBe('https://gateway.example');
    expect(result.CODEX_AUTH_TOKEN).toBe('test-token');
  });

  it('bare .env BASE_URL alone does not trigger OAuth fetch', async () => {
    // A user with a tokenless gateway (e.g. mTLS at the network boundary)
    // configures BASE_URL only. The three-branch predicate must hit the
    // BASE_URL-set branch BEFORE OAuth lookup, so CODEX_CODE_OAUTH_TOKEN
    // must NOT appear in the result. This is the security-regression guard
    // against a token leak to a third-party gateway.
    //
    // Note: EnvManager captures readCodexOAuthToken via a named import at
    // module load, so spyOn on the namespace export only weakly observes
    // the call (the binding inside EnvManager is independent). The
    // behavioral assertions (BASE_URL re-injected AND OAuth token NOT
    // injected) are the load-bearing checks: in the no-OAuth-injection
    // outcome, the only execution path that produces this combination is
    // the new BASE_URL-first branch returning early.
    fs.writeFileSync(
      TEST_ENV_FILE,
      'CODEX_BASE_URL=https://gateway.example\n',
      { mode: 0o600 },
    );

    const oauthSpy = spyOn(oauthToken, 'readCodexOAuthToken');

    try {
      const result = await buildIsolatedEnvWithFreshOAuth();

      expect(result.CODEX_BASE_URL).toBe('https://gateway.example');
      expect(result.CODEX_CODE_OAUTH_TOKEN).toBeUndefined();
      // Best-effort sanity check; see note above.
      expect(oauthSpy).not.toHaveBeenCalled();
    } finally {
      oauthSpy.mockRestore();
    }
  });
});
