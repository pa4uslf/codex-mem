
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export interface SettingsDefaults {
  CODEX_MEM_MODEL: string;
  CODEX_MEM_CONTEXT_OBSERVATIONS: string;
  CODEX_MEM_WORKER_PORT: string;
  CODEX_MEM_WORKER_HOST: string;
  CODEX_MEM_SKIP_TOOLS: string;
  CODEX_MEM_PROVIDER: string;
  CODEX_MEM_CODEX_AUTH_METHOD: string;
  CODEX_MEM_GEMINI_API_KEY: string;
  CODEX_MEM_GEMINI_MODEL: string;
  CODEX_MEM_GEMINI_RATE_LIMITING_ENABLED: string;
  CODEX_MEM_GEMINI_MAX_CONTEXT_MESSAGES: string;
  CODEX_MEM_GEMINI_MAX_TOKENS: string;
  CODEX_MEM_OPENROUTER_API_KEY: string;
  CODEX_MEM_OPENROUTER_MODEL: string;
  CODEX_MEM_OPENROUTER_SITE_URL: string;
  CODEX_MEM_OPENROUTER_APP_NAME: string;
  CODEX_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: string;
  CODEX_MEM_OPENROUTER_MAX_TOKENS: string;
  CODEX_MEM_DATA_DIR: string;
  CODEX_MEM_LOG_LEVEL: string;
  CODEX_MEM_PYTHON_VERSION: string;
  CODEX_CODE_PATH: string;
  CODEX_MEM_MODE: string;
  CODEX_MEM_CONTEXT_SHOW_READ_TOKENS: string;
  CODEX_MEM_CONTEXT_SHOW_WORK_TOKENS: string;
  CODEX_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: string;
  CODEX_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: string;
  CODEX_MEM_CONTEXT_FULL_COUNT: string;
  CODEX_MEM_CONTEXT_FULL_FIELD: string;
  CODEX_MEM_CONTEXT_SESSION_COUNT: string;
  CODEX_MEM_CONTEXT_SHOW_LAST_SUMMARY: string;
  CODEX_MEM_CONTEXT_SHOW_LAST_MESSAGE: string;
  CODEX_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: string;
  CODEX_MEM_WELCOME_HINT_ENABLED: string;
  CODEX_MEM_FOLDER_CODEXMD_ENABLED: string;
  CODEX_MEM_FOLDER_USE_LOCAL_MD: string;
  CODEX_MEM_TRANSCRIPTS_ENABLED: string;
  CODEX_MEM_TRANSCRIPTS_CONFIG_PATH: string;
  CODEX_MEM_CODEX_TRANSCRIPT_INGESTION: string;
  CODEX_MEM_MAX_CONCURRENT_AGENTS: string;
  CODEX_MEM_HOOK_FAIL_LOUD_THRESHOLD: string;
  CODEX_MEM_EXCLUDED_PROJECTS: string;
  CODEX_MEM_FOLDER_MD_EXCLUDE: string;
  CODEX_MEM_SEMANTIC_INJECT: string;
  CODEX_MEM_SEMANTIC_INJECT_LIMIT: string;
  CODEX_MEM_TIER_ROUTING_ENABLED: string;
  CODEX_MEM_TIER_SIMPLE_MODEL: string;
  CODEX_MEM_TIER_SUMMARY_MODEL: string;
  CODEX_MEM_CHROMA_ENABLED: string;
  CODEX_MEM_CHROMA_MODE: string;
  CODEX_MEM_CHROMA_HOST: string;
  CODEX_MEM_CHROMA_PORT: string;
  CODEX_MEM_CHROMA_SSL: string;
  CODEX_MEM_CHROMA_API_KEY: string;
  CODEX_MEM_CHROMA_TENANT: string;
  CODEX_MEM_CHROMA_DATABASE: string;
  CODEX_MEM_TELEGRAM_ENABLED: string;
  CODEX_MEM_TELEGRAM_BOT_TOKEN: string;
  CODEX_MEM_TELEGRAM_CHAT_ID: string;
  CODEX_MEM_TELEGRAM_TRIGGER_TYPES: string;
  CODEX_MEM_TELEGRAM_TRIGGER_CONCEPTS: string;
  CODEX_MEM_QUEUE_ENGINE: string;
  CODEX_MEM_REDIS_URL: string;
  CODEX_MEM_REDIS_HOST: string;
  CODEX_MEM_REDIS_PORT: string;
  CODEX_MEM_REDIS_MODE: string;
  CODEX_MEM_QUEUE_REDIS_PREFIX: string;
  CODEX_MEM_AUTH_MODE: string;
  CODEX_MEM_RUNTIME: string;
  CODEX_MEM_SERVER_BETA_URL: string;
  CODEX_MEM_SERVER_BETA_API_KEY: string;
  CODEX_MEM_SERVER_BETA_PROJECT_ID: string;
}

export class SettingsDefaultsManager {
  private static readonly DEFAULTS: SettingsDefaults = {
    CODEX_MEM_MODEL: 'gpt-5',
    CODEX_MEM_CONTEXT_OBSERVATIONS: '50',
    CODEX_MEM_WORKER_PORT: String(37700 + ((process.getuid?.() ?? 77) % 100)),
    CODEX_MEM_WORKER_HOST: '127.0.0.1',
    CODEX_MEM_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion',
    CODEX_MEM_PROVIDER: 'codex',  // Default to Codex
    CODEX_MEM_CODEX_AUTH_METHOD: 'subscription',  // Default to logged-in Codex CLI auth (not API key)
    CODEX_MEM_GEMINI_API_KEY: '',  // Empty by default, can be set via UI or env
    CODEX_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',  // Default Gemini model (highest free tier RPM)
    CODEX_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true',  // Rate limiting ON by default for free tier users
    CODEX_MEM_GEMINI_MAX_CONTEXT_MESSAGES: '20',  // Max messages in Gemini context window
    CODEX_MEM_GEMINI_MAX_TOKENS: '100000',  // Max estimated tokens (~100k safety limit)
    CODEX_MEM_OPENROUTER_API_KEY: '',  // Empty by default, can be set via UI or env
    CODEX_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',  // Default OpenRouter model (free tier)
    CODEX_MEM_OPENROUTER_SITE_URL: '',  // Optional: for OpenRouter analytics
    CODEX_MEM_OPENROUTER_APP_NAME: 'codex-mem',  // App name for OpenRouter analytics
    CODEX_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: '20',  // Max messages in context window
    CODEX_MEM_OPENROUTER_MAX_TOKENS: '100000',  // Max estimated tokens (~100k safety limit)
    CODEX_MEM_DATA_DIR: join(homedir(), '.codex-mem'),
    CODEX_MEM_LOG_LEVEL: 'INFO',
    CODEX_MEM_PYTHON_VERSION: '3.13',
    CODEX_CODE_PATH: '', // Empty means auto-detect via 'which codex'
    CODEX_MEM_MODE: 'code', // Default mode profile
    CODEX_MEM_CONTEXT_SHOW_READ_TOKENS: 'false',
    CODEX_MEM_CONTEXT_SHOW_WORK_TOKENS: 'false',
    CODEX_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'false',
    CODEX_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',
    CODEX_MEM_CONTEXT_FULL_COUNT: '0',
    CODEX_MEM_CONTEXT_FULL_FIELD: 'narrative',
    CODEX_MEM_CONTEXT_SESSION_COUNT: '10',
    CODEX_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
    CODEX_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
    CODEX_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true',
    CODEX_MEM_WELCOME_HINT_ENABLED: 'true',
    CODEX_MEM_FOLDER_CODEXMD_ENABLED: 'false',
    CODEX_MEM_FOLDER_USE_LOCAL_MD: 'false',  // When true, writes to CODEX.local.md instead of CODEX.md
    CODEX_MEM_TRANSCRIPTS_ENABLED: 'true',
    CODEX_MEM_TRANSCRIPTS_CONFIG_PATH: join(homedir(), '.codex-mem', 'transcript-watch.json'),
    CODEX_MEM_CODEX_TRANSCRIPT_INGESTION: 'false',
    CODEX_MEM_MAX_CONCURRENT_AGENTS: '2',  // Max concurrent Codex CLI subprocesses
    CODEX_MEM_HOOK_FAIL_LOUD_THRESHOLD: '3',  // Plan 05 Phase 8 — escalate to exit code 2 after N consecutive worker-unreachable hook invocations
    CODEX_MEM_EXCLUDED_PROJECTS: '',  // Comma-separated glob patterns for excluded project paths
    CODEX_MEM_FOLDER_MD_EXCLUDE: '[]',  // JSON array of folder paths to exclude from CODEX.md generation
    CODEX_MEM_SEMANTIC_INJECT: 'false',             // Inject relevant past observations on every UserPromptSubmit (experimental, disabled by default)
    CODEX_MEM_SEMANTIC_INJECT_LIMIT: '5',           // Top-N most relevant observations to inject per prompt
    CODEX_MEM_TIER_ROUTING_ENABLED: 'true',         // Route observations to models by complexity
    CODEX_MEM_TIER_SIMPLE_MODEL: 'gpt-5-mini', // Portable tier model for lightweight tasks
    CODEX_MEM_TIER_SUMMARY_MODEL: '',                // Empty = use default model for summaries
    CODEX_MEM_CHROMA_ENABLED: 'true',         // Set to 'false' to disable Chroma and use SQLite-only search
    CODEX_MEM_CHROMA_MODE: 'local',           // 'local' uses persistent chroma-mcp via uvx, 'remote' connects to existing server
    CODEX_MEM_CHROMA_HOST: '127.0.0.1',
    CODEX_MEM_CHROMA_PORT: '8000',
    CODEX_MEM_CHROMA_SSL: 'false',
    CODEX_MEM_CHROMA_API_KEY: '',
    CODEX_MEM_CHROMA_TENANT: 'default_tenant',
    CODEX_MEM_CHROMA_DATABASE: 'default_database',
    CODEX_MEM_TELEGRAM_ENABLED: 'true',
    CODEX_MEM_TELEGRAM_BOT_TOKEN: '',
    CODEX_MEM_TELEGRAM_CHAT_ID: '',
    CODEX_MEM_TELEGRAM_TRIGGER_TYPES: 'security_alert',
    CODEX_MEM_TELEGRAM_TRIGGER_CONCEPTS: '',
    CODEX_MEM_QUEUE_ENGINE: 'sqlite',
    CODEX_MEM_REDIS_URL: '',
    CODEX_MEM_REDIS_HOST: '127.0.0.1',
    CODEX_MEM_REDIS_PORT: '6379',
    CODEX_MEM_REDIS_MODE: 'external',
    CODEX_MEM_QUEUE_REDIS_PREFIX: `codex_mem_${process.env.CODEX_MEM_WORKER_PORT ?? String(37700 + ((process.getuid?.() ?? 77) % 100))}`,
    CODEX_MEM_AUTH_MODE: 'api-key',
    CODEX_MEM_RUNTIME: 'worker',
    CODEX_MEM_SERVER_BETA_URL: `http://127.0.0.1:${process.env.CODEX_MEM_SERVER_PORT ?? String(37877 + ((process.getuid?.() ?? 77) % 100))}`,  // Default server-beta runtime URL — UID-derived for multi-account isolation
    CODEX_MEM_SERVER_BETA_API_KEY: '',                     // Local hook API key, populated by installer when runtime=server-beta
    CODEX_MEM_SERVER_BETA_PROJECT_ID: '',                  // Default Postgres project_id used by hooks when runtime=server-beta
  };

  static getAllDefaults(): SettingsDefaults {
    return { ...this.DEFAULTS };
  }

  static get(key: keyof SettingsDefaults): string {
    return process.env[key] ?? this.DEFAULTS[key];
  }

  static getInt(key: keyof SettingsDefaults): number {
    const value = this.get(key);
    return parseInt(value, 10);
  }

  static getBool(key: keyof SettingsDefaults): boolean {
    const value: unknown = this.get(key);
    return value === 'true' || value === true;
  }

  private static applyEnvOverrides(settings: SettingsDefaults): SettingsDefaults {
    const result = { ...settings };
    for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
      if (process.env[key] !== undefined) {
        result[key] = process.env[key]!;
      }
    }
    return result;
  }

  static loadFromFile(settingsPath: string): SettingsDefaults {
    try {
      if (!existsSync(settingsPath)) {
        const defaults = this.getAllDefaults();
        try {
          const dir = dirname(settingsPath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
          console.log('[SETTINGS] Created settings file with defaults:', settingsPath);
        } catch (error: unknown) {
          console.warn('[SETTINGS] Failed to create settings file, using in-memory defaults:', settingsPath, error instanceof Error ? error.message : String(error));
        }
        return this.applyEnvOverrides(defaults);
      }

      const settingsData = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsData);

      let flatSettings = settings;
      if (settings.env && typeof settings.env === 'object') {
        flatSettings = settings.env;

        try {
          writeFileSync(settingsPath, JSON.stringify(flatSettings, null, 2), 'utf-8');
          console.log('[SETTINGS] Migrated settings file from nested to flat schema:', settingsPath);
        } catch (error: unknown) {
          console.warn('[SETTINGS] Failed to auto-migrate settings file:', settingsPath, error instanceof Error ? error.message : String(error));
          // Continue with in-memory migration even if write fails
        }
      }

      const result: SettingsDefaults = { ...this.DEFAULTS };
      for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
        if (flatSettings[key] !== undefined) {
          result[key] = flatSettings[key];
        }
      }

      return this.applyEnvOverrides(result);
    } catch (error: unknown) {
      console.warn('[SETTINGS] Failed to load settings, using defaults:', settingsPath, error instanceof Error ? error.message : String(error));
      return this.applyEnvOverrides(this.getAllDefaults());
    }
  }
}
