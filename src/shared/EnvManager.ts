
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { logger } from '../utils/logger.js';
import { paths } from './paths.js';
import {
  readCodexOAuthToken,
  writeStaleMarker,
  clearStaleMarker,
  type OAuthTokenResult,
} from './oauth-token.js';

// Resolved lazily so tests (and any rare runtime path-overrides) can target a
// temp file via CODEX_MEM_ENV_FILE without depending on module-load order.
// Production callers see the canonical ~/.codex-mem/.env path through
// paths.envFile() unchanged.
export function envFilePath(): string {
  return process.env.CODEX_MEM_ENV_FILE ?? paths.envFile();
}

/** @deprecated Prefer envFilePath(); kept as a snapshot for back-compat. */
export const ENV_FILE_PATH = envFilePath();

const BLOCKED_ENV_VARS = [
  'CODEX_API_KEY',       // Issue #733: Prevent auto-discovery from project .env files
  'CODEX_AUTH_TOKEN',    // Same leak risk as CODEX_API_KEY; a token inherited from the
                             // shell would otherwise short-circuit OAuth lookup at spawn time.
                             // The fresh token from ~/.codex-mem/.env is re-injected below
                             // when explicit gateway credentials are configured.
  'CODEX_BASE_URL',      // Issue #2375: same leak class as AUTH_TOKEN. A leaked BASE_URL
                             // alone (no token) was enough to trigger the OAuth-skip path,
                             // sending the subprocess to a proxy with no credentials.
                             // Re-injected from ~/.codex-mem/.env when configured.
  'CODEXCODE',              // Prevent "cannot be launched inside another Codex Code session" error
  'CODEX_CODE_OAUTH_TOKEN', // Issue #2215: prevent stale parent-process token from leaking into
                             // isolated env. The fresh token is read from the keychain at spawn
                             // time by buildIsolatedEnvWithFreshOAuth().
];

export interface CodexMemEnv {
  CODEX_API_KEY?: string;
  CODEX_BASE_URL?: string;
  CODEX_AUTH_TOKEN?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key) {
      result[key] = value;
    }
  }

  return result;
}

function serializeEnvFile(env: Record<string, string>): string {
  const lines: string[] = [
    '# codex-mem credentials',
    '# This file stores keys and gateway settings for the codex-mem memory agent',
    '# Edit this file or use codex-mem settings to configure',
    '',
  ];

  for (const [key, value] of Object.entries(env)) {
    if (value) {
      const needsQuotes = /[\s#=]/.test(value);
      lines.push(`${key}=${needsQuotes ? `"${value}"` : value}`);
    }
  }

  return lines.join('\n') + '\n';
}

export function loadCodexMemEnv(): CodexMemEnv {
  const envFile = envFilePath();
  if (!existsSync(envFile)) {
    return {};
  }

  try {
    const content = readFileSync(envFile, 'utf-8');
    const parsed = parseEnvFile(content);

    const result: CodexMemEnv = {};
    if (parsed.CODEX_API_KEY) result.CODEX_API_KEY = parsed.CODEX_API_KEY;
    if (parsed.CODEX_BASE_URL) result.CODEX_BASE_URL = parsed.CODEX_BASE_URL;
    if (parsed.CODEX_AUTH_TOKEN) result.CODEX_AUTH_TOKEN = parsed.CODEX_AUTH_TOKEN;
    if (parsed.GEMINI_API_KEY) result.GEMINI_API_KEY = parsed.GEMINI_API_KEY;
    if (parsed.OPENROUTER_API_KEY) result.OPENROUTER_API_KEY = parsed.OPENROUTER_API_KEY;

    return result;
  } catch (error: unknown) {
    logger.warn('ENV', 'Failed to load .env file', { path: envFile }, error instanceof Error ? error : new Error(String(error)));
    return {};
  }
}

export function saveCodexMemEnv(env: CodexMemEnv): void {
  const envFile = envFilePath();
  let existing: Record<string, string> = {};
  try {
    if (!existsSync(paths.dataDir())) {
      mkdirSync(paths.dataDir(), { recursive: true, mode: 0o700 });
    }
    chmodSync(paths.dataDir(), 0o700);

    existing = existsSync(envFile)
      ? parseEnvFile(readFileSync(envFile, 'utf-8'))
      : {};
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    logger.error('ENV', 'Failed to set up env directory or read existing env', {}, normalizedError);
    throw normalizedError;
  }

  const updated: Record<string, string> = { ...existing };

  if (env.CODEX_API_KEY !== undefined) {
    if (env.CODEX_API_KEY) {
      updated.CODEX_API_KEY = env.CODEX_API_KEY;
    } else {
      delete updated.CODEX_API_KEY;
    }
  }
  if (env.CODEX_BASE_URL !== undefined) {
    if (env.CODEX_BASE_URL) {
      updated.CODEX_BASE_URL = env.CODEX_BASE_URL;
    } else {
      delete updated.CODEX_BASE_URL;
    }
  }
  if (env.CODEX_AUTH_TOKEN !== undefined) {
    if (env.CODEX_AUTH_TOKEN) {
      updated.CODEX_AUTH_TOKEN = env.CODEX_AUTH_TOKEN;
    } else {
      delete updated.CODEX_AUTH_TOKEN;
    }
  }
  if (env.GEMINI_API_KEY !== undefined) {
    if (env.GEMINI_API_KEY) {
      updated.GEMINI_API_KEY = env.GEMINI_API_KEY;
    } else {
      delete updated.GEMINI_API_KEY;
    }
  }
  if (env.OPENROUTER_API_KEY !== undefined) {
    if (env.OPENROUTER_API_KEY) {
      updated.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
    } else {
      delete updated.OPENROUTER_API_KEY;
    }
  }

  try {
    writeFileSync(envFile, serializeEnvFile(updated), { encoding: 'utf-8', mode: 0o600 });
    chmodSync(envFile, 0o600);
  } catch (error: unknown) {
    logger.error('ENV', 'Failed to save .env file', { path: envFile }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

export function buildIsolatedEnv(includeCredentials: boolean = true): Record<string, string> {
  const isolatedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !BLOCKED_ENV_VARS.includes(key)) {
      isolatedEnv[key] = value;
    }
  }

  isolatedEnv.CODEX_CODE_ENTRYPOINT = 'sdk-ts';

  isolatedEnv.CODEX_MEM_INTERNAL = '1';

  if (includeCredentials) {
    const credentials = loadCodexMemEnv();

    if (credentials.CODEX_API_KEY) {
      isolatedEnv.CODEX_API_KEY = credentials.CODEX_API_KEY;
    }
    if (credentials.CODEX_BASE_URL) {
      isolatedEnv.CODEX_BASE_URL = credentials.CODEX_BASE_URL;
    }
    if (credentials.CODEX_AUTH_TOKEN) {
      isolatedEnv.CODEX_AUTH_TOKEN = credentials.CODEX_AUTH_TOKEN;
    }
    if (credentials.GEMINI_API_KEY) {
      isolatedEnv.GEMINI_API_KEY = credentials.GEMINI_API_KEY;
    }
    if (credentials.OPENROUTER_API_KEY) {
      isolatedEnv.OPENROUTER_API_KEY = credentials.OPENROUTER_API_KEY;
    }

    // Note: CODEX_CODE_OAUTH_TOKEN is intentionally NOT copied from
    // process.env here. OAuth tokens have refresh semantics that this
    // sync path cannot model — copying a parent-process token captured
    // at startup means injecting a stale token days later (issue #2215).
    // Use buildIsolatedEnvWithFreshOAuth() for spawn-time injection.
  }

  return isolatedEnv;
}

/**
 * Async variant of buildIsolatedEnv() that reads the OAuth token from the
 * platform-native credential store at the moment of spawn. Use this at SDK
 * spawn-time so the worker subprocess always gets a fresh token.
 *
 * Behavior per OAuthTokenResult:
 *   - present: inject as CODEX_CODE_OAUTH_TOKEN env var, clear stale marker.
 *   - expired: do NOT inject. Log re-login message. Write stale marker so
 *     the session-start hook can surface the message to the user.
 *   - absent: proceed without the token. Worker may fall back to
 *     CODEX_API_KEY or other auth.
 *
 * Issue #2215: this replaces the old "copy CODEX_CODE_OAUTH_TOKEN from
 * process.env" path which silently injected stale tokens.
 */
export async function buildIsolatedEnvWithFreshOAuth(
  includeCredentials: boolean = true,
): Promise<Record<string, string>> {
  const isolatedEnv = buildIsolatedEnv(includeCredentials);

  // Defensive: ensure no parent-process OAuth token survives this path even
  // if BLOCKED_ENV_VARS is bypassed. Issue #2215.
  delete isolatedEnv.CODEX_CODE_OAUTH_TOKEN;

  if (!includeCredentials) return isolatedEnv;

  // Custom gateway: never inject OAuth (would leak the user's Codex OAuth
  // token to a third-party gateway). The user must explicitly configure a
  // gateway-appropriate token in ~/.codex-mem/.env if their gateway requires
  // one. A bare BASE_URL with no token = tokenless gateway (e.g. mTLS at the
  // network boundary).
  if (isolatedEnv.CODEX_BASE_URL) {
    clearStaleMarker();
    return isolatedEnv;
  }
  // Direct API with explicit credentials: skip OAuth lookup.
  if (isolatedEnv.CODEX_API_KEY || isolatedEnv.CODEX_AUTH_TOKEN) {
    clearStaleMarker();
    return isolatedEnv;
  }

  let result: OAuthTokenResult;
  try {
    result = await readCodexOAuthToken();
  } catch (error) {
    logger.warn(
      'OAUTH',
      'OAuth token read failed unexpectedly; proceeding without token',
      {},
      error instanceof Error ? error : new Error(String(error)),
    );
    return isolatedEnv;
  }

  switch (result.kind) {
    case 'present':
      isolatedEnv.CODEX_CODE_OAUTH_TOKEN = result.token;
      logger.info('OAUTH', 'Injected fresh CODEX_CODE_OAUTH_TOKEN at spawn-time', {
        source: result.source,
        expiresAt: result.expiresAt,
      });
      clearStaleMarker();
      break;
    case 'expired':
      logger.warn(
        'OAUTH',
        `Refusing to inject expired CODEX_CODE_OAUTH_TOKEN: ${result.reason}. Re-login via Codex Desktop to refresh.`,
        { expiresAt: result.expiresAt },
      );
      writeStaleMarker(result.reason);
      break;
    case 'absent':
      logger.debug('OAUTH', `No OAuth token available: ${result.reason}`);
      // Token is absent — any prior stale-marker would have been written
      // when the token was expired, but is no longer accurate now that the
      // token is gone. Clear it so the session-start hook stops surfacing
      // a stale "expired token, re-login" warning (CodeRabbit review on PR
      // #2282).
      clearStaleMarker();
      break;
  }

  return isolatedEnv;
}

export function getCredential(key: keyof CodexMemEnv): string | undefined {
  const env = loadCodexMemEnv();
  return env[key];
}

export function hasCodexApiKey(): boolean {
  const env = loadCodexMemEnv();
  return !!env.CODEX_API_KEY;
}

export function hasCodexAuthToken(): boolean {
  const env = loadCodexMemEnv();
  return !!env.CODEX_AUTH_TOKEN;
}

export function getAuthMethodDescription(): string {
  if (hasCodexApiKey()) {
    return 'API key (from ~/.codex-mem/.env)';
  }
  if (hasCodexAuthToken()) {
    return 'Gateway auth token (from ~/.codex-mem/.env)';
  }
  // Note: this is a quick sync hint for logging — the authoritative OAuth
  // path is buildIsolatedEnvWithFreshOAuth() which reads the keychain at
  // spawn time. process.env may or may not carry a token here.
  if (process.env.CODEX_CODE_OAUTH_TOKEN) {
    return 'Codex Code OAuth token (env, refreshed via keychain at spawn)';
  }
  return 'Codex Code OAuth token (read from system keychain at spawn)';
}
