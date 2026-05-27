
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, OBSERVER_SESSIONS_DIR, ensureDir, paths } from '../../shared/paths.js';
import { buildIsolatedEnv, getAuthMethodDescription } from '../../shared/EnvManager.js';
import { findCodexExecutable } from '../../shared/find-codex-executable.js';
import type { ActiveSession, PendingMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import { processAgentResponse, type WorkerRef } from './agents/index.js';
import { waitForSlot } from '../../supervisor/process-registry.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Module-scoped guard so the "effort parameter" hint only fires once per
 * worker process. The underlying cause (a leaked CODEX_CODE_EFFORT_LEVEL in
 * ~/.codex-mem/.env, see #2357) is environmental — re-logging it on every
 * SDK call would spam the logs without adding signal.
 *
 * Exported solely for tests to reset the latch between cases.
 */
let effortHintLogged = false;
export function __resetEffortHintLatchForTesting(): void {
  effortHintLogged = false;
}

/**
 * Classify a CodexProvider error (executable spawn failures, SDK errors,
 * Codex API errors). Provider-specific because it relies on:
 *   - SDK error class names (e.g. OverloadedError) when present
 *   - spawn errors (ENOENT) when the Codex executable is missing
 *   - Codex-specific message strings ("Invalid API key", "Prompt is too long")
 */
export function classifyCodexError(err: unknown): ClassifiedProviderError {
  const message = err instanceof Error ? err.message : String(err);
  const errAny = err as { name?: string; status?: number; error?: { type?: string }; body?: unknown };

  // Executable / spawn issues — unrecoverable, no point retrying.
  if (
    message.includes('Codex executable not found') ||
    message.includes('CODEX_CODE_PATH') ||
    message.includes('ENOENT') ||
    message.startsWith('spawn ')
  ) {
    return new ClassifiedProviderError(message, { kind: 'unrecoverable', cause: err });
  }

  // Codex auth failures.
  if (
    errAny.status === 401 ||
    errAny.status === 403 ||
    message.includes('Invalid API key') ||
    message.includes('API_KEY_INVALID') ||
    message.includes('API key expired') ||
    message.includes('API key not valid')
  ) {
    return new ClassifiedProviderError(message, { kind: 'auth_invalid', cause: err });
  }

  // SDK-level overloaded — Codex emits OverloadedError or 529 with type:'overloaded_error'.
  if (
    errAny.name === 'OverloadedError' ||
    errAny.status === 529 ||
    errAny.error?.type === 'overloaded_error'
  ) {
    return new ClassifiedProviderError(message || 'Codex overloaded', { kind: 'transient', cause: err });
  }

  // Rate limit.
  if (errAny.status === 429) {
    return new ClassifiedProviderError(message, { kind: 'rate_limit', cause: err });
  }

  // Quota.
  if (message.toLowerCase().includes('quota exceeded')) {
    return new ClassifiedProviderError(message, { kind: 'quota_exhausted', cause: err });
  }

  // Context overflow — unrecoverable in this session, requires reset.
  if (
    message.includes('Prompt is too long') ||
    message.includes('prompt is too long') ||
    message.includes('context window')
  ) {
    return new ClassifiedProviderError(message, { kind: 'unrecoverable', cause: err });
  }

  // HTTP 400 from the Codex CLI — bad request, never recoverable. Mirrors
  // the pattern in GeminiProvider.classifyGeminiError / classifyOpenRouterError
  // (see #2357: the SDK forwards `effort` to the Messages API when
  // CODEX_CODE_EFFORT_LEVEL leaks into the subprocess env, and models like
  // Haiku/Sonnet 4.5 reject with 400 — without this branch the default
  // `transient` classification retried indefinitely).
  if (errAny.status === 400) {
    // Inspect both the message and any structured body for the effort marker.
    const bodyText = (() => {
      const body = errAny.body;
      if (typeof body === 'string') return body;
      if (body && typeof body === 'object') {
        try { return JSON.stringify(body); } catch { return ''; }
      }
      return '';
    })();
    const haystack = `${message}\n${bodyText}`;
    if (/effort parameter/i.test(haystack) && !effortHintLogged) {
      effortHintLogged = true;
      logger.warn(
        'SDK',
        'Codex API rejected request with HTTP 400: this model does not support the `effort` parameter. ' +
          'CODEX_CODE_EFFORT_LEVEL is likely leaking into the SDK subprocess env via ~/.codex-mem/.env — ' +
          'remove it or scope it to models that support effort. See https://github.com/thedotmack/codex-mem/issues/2357.',
        { status: 400 }
      );
    }
    return new ClassifiedProviderError(
      message || 'Codex bad request (status 400)',
      { kind: 'unrecoverable', cause: err },
    );
  }

  // Server errors → transient.
  if (typeof errAny.status === 'number' && errAny.status >= 500 && errAny.status < 600) {
    return new ClassifiedProviderError(message, { kind: 'transient', cause: err });
  }

  // Default: treat unknown errors as transient (preserve old behavior of
  // retrying everything not explicitly marked unrecoverable).
  return new ClassifiedProviderError(message, { kind: 'transient', cause: err });
}

export class CodexProvider {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  private resetSessionForFreshStart(session: ActiveSession): void {
    this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, null);
    session.memorySessionId = null;
    session.forceInit = true;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const codexPath = findCodexExecutable('SDK');
    const modelId = session.modelOverride || this.getModelId();

    if (session.forceInit) {
      logger.info('SDK', 'forceInit flag set, starting fresh SDK session', {
        sessionDbId: session.sessionDbId,
        previousMemorySessionId: session.memorySessionId
      });
      session.forceInit = false;
    }

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxConcurrent = parseInt(settings.CODEX_MEM_MAX_CONCURRENT_AGENTS, 10) || 2;
    await waitForSlot(maxConcurrent, session.abortController.signal);

    const isolatedEnv = sanitizeEnv(buildIsolatedEnv()) as Record<string, string>;
    const authMethod = getAuthMethodDescription();

    logger.info('SDK', 'Starting Codex exec processor', {
      sessionDbId: session.sessionDbId,
      contentSessionId: session.contentSessionId,
      memorySessionId: session.memorySessionId ?? undefined,
      lastPromptNumber: session.lastPromptNumber,
      authMethod
    });

    ensureDir(OBSERVER_SESSIONS_DIR);
    if (!session.memorySessionId) {
      const syntheticMemorySessionId = `codex-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = syntheticMemorySessionId;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
      logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=Codex`);
    }

    await this.processPrompt(session, buildInitialPrompt(session), worker, codexPath, modelId, isolatedEnv, undefined);

    for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
      session.pendingAgentId = message.agentId ?? null;
      session.pendingAgentType = message.agentType ?? null;
      if (message.prompt_number !== undefined) {
        session.lastPromptNumber = message.prompt_number;
      }
      await this.processPrompt(session, this.buildPromptForPendingMessage(session, message), worker, codexPath, modelId, isolatedEnv, message.cwd);
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'Agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`
    });
  }

  private buildPromptForPendingMessage(session: ActiveSession, message: PendingMessage): string {
    if (message.type === 'observation') {
      return buildObservationPrompt({
        id: 0,
        tool_name: message.tool_name!,
        tool_input: JSON.stringify(message.tool_input),
        tool_output: JSON.stringify(message.tool_response),
        created_at_epoch: Date.now(),
        cwd: message.cwd
      });
    }

    return buildSummaryPrompt({
      id: session.sessionDbId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
      last_assistant_message: message.last_assistant_message || ''
    }, ModeManager.getInstance().getActiveMode());
  }

  private async processPrompt(
    session: ActiveSession,
    prompt: string,
    worker: WorkerRef | undefined,
    codexPath: string,
    modelId: string,
    env: Record<string, string>,
    cwd?: string,
  ): Promise<void> {
    session.conversationHistory.push({ role: 'user', content: prompt });
    const originalTimestamp = session.earliestPendingTimestamp;
    const textContent = await runCodexExec(codexPath, prompt, modelId, env, session.abortController.signal);

    if (textContent.includes('prompt is too long') || textContent.includes('context window')) {
      this.resetSessionForFreshStart(session);
      session.abortReason = 'overflow';
      session.abortController.abort();
      throw new Error('Codex session context overflow: prompt is too long');
    }

    session.conversationHistory.push({ role: 'assistant', content: textContent });
    await processAgentResponse(
      textContent,
      session,
      this.dbManager,
      this.sessionManager,
      worker,
      0,
      originalTimestamp,
      'Codex',
      cwd,
      modelId,
    );
  }

  private getModelId(): string {
    const settingsPath = paths.settings();
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    return settings.CODEX_MEM_MODEL;
  }
}

function buildInitialPrompt(session: ActiveSession): string {
  const mode = ModeManager.getInstance().getActiveMode();
  return session.lastPromptNumber === 1
    ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
    : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);
}

function runCodexExec(
  codexPath: string,
  prompt: string,
  modelId: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-mem-'));
  const outputPath = join(tempDir, 'last-message.txt');
  const args = [
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--cd',
    OBSERVER_SESSIONS_DIR,
    '--output-last-message',
    outputPath,
    ...(modelId ? ['--model', modelId] : []),
    '-',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(codexPath, args, {
      cwd: OBSERVER_SESSIONS_DIR,
      env,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';

    const abort = () => {
      child.kill('SIGTERM');
      reject(new Error('Codex exec aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      signal.removeEventListener('abort', abort);
      rmSync(tempDir, { recursive: true, force: true });
      reject(error);
    });
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      try {
        if (code !== 0) {
          reject(new Error(`codex exec failed with exit code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
          return;
        }
        resolve(readFileSync(outputPath, 'utf-8').trim());
      } catch (error) {
        reject(error);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
    child.stdin.end(prompt);
  });
}
