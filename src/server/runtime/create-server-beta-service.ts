// SPDX-License-Identifier: Apache-2.0

import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { createPostgresStorageRepositories, getSharedPostgresPool, SERVER_BETA_POSTGRES_SCHEMA_VERSION } from '../../storage/postgres/index.js';
import { bootstrapServerBetaPostgresSchema } from '../../storage/postgres/schema.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { getRedisQueueConfig } from '../queue/redis-config.js';
import { ActiveServerBetaQueueManager } from './ActiveServerBetaQueueManager.js';
import { ActiveServerBetaGenerationWorkerManager } from './ActiveServerBetaGenerationWorkerManager.js';
import { CodexObservationProvider } from '../generation/providers/CodexObservationProvider.js';
import { GeminiObservationProvider } from '../generation/providers/GeminiObservationProvider.js';
import { OpenRouterObservationProvider } from '../generation/providers/OpenRouterObservationProvider.js';
import type { ServerGenerationProvider } from '../generation/providers/shared/types.js';
import { ServerBetaService } from './ServerBetaService.js';
import {
  DisabledServerBetaEventBroadcaster,
  DisabledServerBetaGenerationWorkerManager,
  DisabledServerBetaProviderRegistry,
  DisabledServerBetaQueueManager,
  type ServerBetaAuthMode,
  type ServerBetaBootstrapStatus,
  type ServerBetaGenerationWorkerManager,
  type ServerBetaQueueManager,
  type ServerBetaServiceGraph,
} from './types.js';

export interface CreateServerBetaServiceOptions {
  pool?: PostgresPool;
  authMode?: ServerBetaAuthMode;
  bootstrapSchema?: boolean;
  queueManager?: ServerBetaQueueManager;
  // Phase 5 seam: tests can inject a fake provider without env config.
  generationProvider?: ServerGenerationProvider;
  generationWorkerManager?: ServerBetaGenerationWorkerManager;
  // Phase 10: when true, skip building the generation worker. Used when the
  // service is just an HTTP front-end and a separate `server worker` process
  // consumes the BullMQ queues.
  generationDisabled?: boolean;
  // Phase 10: skip env validation (tests). Production code paths always run
  // validation so misconfiguration fails fast at startup.
  skipEnvValidation?: boolean;
}

// Phase 10 — env validation. Server beta in Docker requires explicit, complete
// configuration. Missing pieces fail fast at startup rather than silently
// degrading. Required env when running in Docker:
//   - CODEX_MEM_SERVER_DATABASE_URL  (Postgres)
//   - CODEX_MEM_QUEUE_ENGINE=bullmq  (no in-memory queue in Docker)
//   - CODEX_MEM_REDIS_URL            (BullMQ requires Redis/Valkey)
//   - CODEX_MEM_AUTH_MODE != local-dev (auth must be real in Docker)
// `local-dev` bypass is only valid on a developer's loopback; in Docker the
// container is reachable via service-to-service networking and exposed ports,
// so the loopback assumption is invalid.
export interface ServerBetaEnvValidationOptions {
  env?: NodeJS.ProcessEnv;
  isDocker?: boolean;
}

export interface ServerBetaEnvValidationResult {
  isDocker: boolean;
  runtime: string;
  authMode: string;
  queueEngine: string;
  hasDatabaseUrl: boolean;
  hasRedisUrl: boolean;
}

export function detectDockerEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CODEX_MEM_DOCKER === '1' || env.CODEX_MEM_DOCKER === 'true') return true;
  // /.dockerenv is the canonical Docker marker; existsSync is cheap.
  try {
    if (existsSync('/.dockerenv')) return true;
  } catch {
    // ignore
  }
  return false;
}

export function validateServerBetaEnv(
  options: ServerBetaEnvValidationOptions = {},
): ServerBetaEnvValidationResult {
  const env = options.env ?? process.env;
  const isDocker = options.isDocker ?? detectDockerEnvironment(env);
  const errors: string[] = [];

  const runtime = (env.CODEX_MEM_RUNTIME ?? '').trim();
  if (!runtime) {
    // Warn but allow — defaulted to 'worker' upstream; we log a warning so
    // operators know server-beta is the active runtime here.
    if (isDocker) {
      logger.warn('SYSTEM', 'CODEX_MEM_RUNTIME unset; server-beta container assumes runtime=server-beta');
    }
  } else if (runtime !== 'server-beta' && isDocker) {
    errors.push(
      `CODEX_MEM_RUNTIME=${runtime} is invalid in Docker; the server-beta image only runs CODEX_MEM_RUNTIME=server-beta.`,
    );
  }

  const authMode = (env.CODEX_MEM_AUTH_MODE ?? 'api-key').trim();
  if (isDocker) {
    if (authMode === 'local-dev') {
      errors.push(
        'CODEX_MEM_AUTH_MODE=local-dev is not allowed in Docker. Set CODEX_MEM_AUTH_MODE=api-key and create a key with `codex-mem server api-key create`.',
      );
    }
    if (
      env.CODEX_MEM_ALLOW_LOCAL_DEV_BYPASS === '1'
      || env.CODEX_MEM_ALLOW_LOCAL_DEV_BYPASS === 'true'
    ) {
      errors.push(
        'CODEX_MEM_ALLOW_LOCAL_DEV_BYPASS is not allowed in Docker. Loopback bypass cannot be enforced inside a container; remove the variable.',
      );
    }
  }

  const queueEngine = (env.CODEX_MEM_QUEUE_ENGINE ?? '').trim().toLowerCase();
  if (isDocker) {
    if (!queueEngine) {
      errors.push('CODEX_MEM_QUEUE_ENGINE is required in Docker; set it to "bullmq".');
    } else if (queueEngine !== 'bullmq') {
      errors.push(
        `CODEX_MEM_QUEUE_ENGINE=${queueEngine} is not allowed in Docker. Only "bullmq" is supported (no in-process queues across container boundaries).`,
      );
    }
  }

  const hasDatabaseUrl = Boolean((env.CODEX_MEM_SERVER_DATABASE_URL ?? '').trim());
  if (!hasDatabaseUrl) {
    errors.push('CODEX_MEM_SERVER_DATABASE_URL is required to start server-beta (Postgres connection string).');
  }

  const hasRedisUrl = Boolean((env.CODEX_MEM_REDIS_URL ?? '').trim());
  if (queueEngine === 'bullmq' && !hasRedisUrl) {
    errors.push('CODEX_MEM_REDIS_URL is required when CODEX_MEM_QUEUE_ENGINE=bullmq.');
  }

  if (errors.length > 0) {
    const message = [
      'server-beta startup configuration is invalid:',
      ...errors.map(line => `  - ${line}`),
    ].join('\n');
    throw new Error(message);
  }

  return {
    isDocker,
    runtime: runtime || 'server-beta',
    authMode,
    queueEngine: queueEngine || 'disabled',
    hasDatabaseUrl,
    hasRedisUrl,
  };
}

export async function createServerBetaService(
  options: CreateServerBetaServiceOptions = {},
): Promise<ServerBetaService> {
  if (!options.skipEnvValidation) {
    validateServerBetaEnv();
  }
  const pool = options.pool ?? getSharedPostgresPool({ requireDatabaseUrl: true });
  const bootstrap = await initializePostgres(pool, options.bootstrapSchema ?? true);
  const queueManager = options.queueManager ?? buildQueueManager();
  const generationDisabled = options.generationDisabled
    ?? (process.env.CODEX_MEM_GENERATION_DISABLED === '1'
      || process.env.CODEX_MEM_GENERATION_DISABLED === 'true');
  const generationWorkerManager = options.generationWorkerManager
    ?? (generationDisabled
      ? new DisabledServerBetaGenerationWorkerManager(
          'CODEX_MEM_GENERATION_DISABLED is set; this server runs HTTP only. A separate `codex-mem server worker start` process consumes the BullMQ queues.',
        )
      : buildGenerationWorkerManager(pool, queueManager, options.generationProvider));
  const graph: ServerBetaServiceGraph = {
    runtime: 'server-beta',
    postgres: {
      pool,
      bootstrap,
    },
    authMode: options.authMode ?? parseAuthMode(process.env.CODEX_MEM_AUTH_MODE),
    queueManager,
    generationWorkerManager,
    providerRegistry: new DisabledServerBetaProviderRegistry('Phase 5 keeps the provider registry boundary as inert; per-call providers are owned by the generation worker manager.'),
    eventBroadcaster: new DisabledServerBetaEventBroadcaster('Phase 2 boundary only; SSE/event broadcasting is not wired.'),
    storage: createPostgresStorageRepositories(pool),
  };

  if (generationWorkerManager instanceof ActiveServerBetaGenerationWorkerManager) {
    generationWorkerManager.start();
  }

  return new ServerBetaService({ graph });
}

function buildGenerationWorkerManager(
  pool: PostgresPool,
  queueManager: ServerBetaQueueManager,
  injectedProvider?: ServerGenerationProvider,
): ServerBetaGenerationWorkerManager {
  if (!(queueManager instanceof ActiveServerBetaQueueManager)) {
    return new DisabledServerBetaGenerationWorkerManager(
      'queue manager is disabled; set CODEX_MEM_QUEUE_ENGINE=bullmq to enable provider generation.',
    );
  }
  const provider = injectedProvider ?? buildServerGenerationProviderFromEnv();
  if (!provider) {
    return new DisabledServerBetaGenerationWorkerManager(
      'no server generation provider configured; set CODEX_MEM_SERVER_PROVIDER and the matching API key to enable.',
    );
  }
  return new ActiveServerBetaGenerationWorkerManager({
    pool,
    queueManager,
    provider,
  });
}

function buildServerGenerationProviderFromEnv(): ServerGenerationProvider | null {
  const provider = (process.env.CODEX_MEM_SERVER_PROVIDER ?? '').trim().toLowerCase();
  if (!provider) return null;
  try {
    if (provider === 'codex' || provider === 'openai') {
      const apiKey = process.env.OPENAI_API_KEY ?? process.env.CODEX_API_KEY ?? process.env.CODEX_MEM_CODEX_API_KEY ?? '';
      if (!apiKey) return null;
      const opts: { apiKey: string; model?: string; apiUrl?: string } = { apiKey };
      if (process.env.CODEX_MEM_SERVER_MODEL) opts.model = process.env.CODEX_MEM_SERVER_MODEL;
      if (process.env.CODEX_MEM_OPENAI_RESPONSES_URL) opts.apiUrl = process.env.CODEX_MEM_OPENAI_RESPONSES_URL;
      return new CodexObservationProvider(opts);
    }
    if (provider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY ?? process.env.CODEX_MEM_GEMINI_API_KEY ?? '';
      if (!apiKey) return null;
      const opts: { apiKey: string; model?: string } = { apiKey };
      if (process.env.CODEX_MEM_SERVER_MODEL) opts.model = process.env.CODEX_MEM_SERVER_MODEL;
      return new GeminiObservationProvider(opts);
    }
    if (provider === 'openrouter') {
      const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.CODEX_MEM_OPENROUTER_API_KEY ?? '';
      if (!apiKey) return null;
      const opts: { apiKey: string; model?: string } = { apiKey };
      if (process.env.CODEX_MEM_SERVER_MODEL) opts.model = process.env.CODEX_MEM_SERVER_MODEL;
      return new OpenRouterObservationProvider(opts);
    }
  } catch {
    return null;
  }
  return null;
}

// Queue manager selection is fail-fast on misconfiguration. If the user
// explicitly opts into BullMQ via CODEX_MEM_QUEUE_ENGINE=bullmq we build
// the active manager; any error there throws so the runtime does not
// silently fall back to a disabled queue. Default behavior (sqlite engine
// or no opt-in) keeps the disabled boundary so worker-era runtimes stay
// compatible.
function buildQueueManager(): ServerBetaQueueManager {
  const config = getRedisQueueConfig();
  if (config.engine !== 'bullmq') {
    return new DisabledServerBetaQueueManager(
      `Queue engine is "${config.engine}"; set CODEX_MEM_QUEUE_ENGINE=bullmq to activate the server-beta queue manager.`,
    );
  }
  return new ActiveServerBetaQueueManager(config);
}

async function initializePostgres(pool: PostgresPool, bootstrapSchema: boolean): Promise<ServerBetaBootstrapStatus> {
  if (!bootstrapSchema) {
    return { initialized: false, schemaVersion: null, appliedAt: null };
  }

  await bootstrapServerBetaPostgresSchema(pool);
  const result = await pool.query(
    `
      SELECT version, applied_at
      FROM server_beta_schema_migrations
      WHERE version = $1
    `,
    [SERVER_BETA_POSTGRES_SCHEMA_VERSION],
  );
  const row = result.rows[0] as { version?: number; applied_at?: Date | string } | undefined;

  return {
    initialized: row?.version === SERVER_BETA_POSTGRES_SCHEMA_VERSION,
    schemaVersion: typeof row?.version === 'number' ? row.version : null,
    appliedAt: row?.applied_at ? new Date(row.applied_at).toISOString() : null,
  };
}

function parseAuthMode(value: string | undefined): ServerBetaAuthMode {
  if (value === 'local-dev' || value === 'disabled') {
    return value;
  }
  return 'api-key';
}
