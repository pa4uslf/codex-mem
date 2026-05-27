import * as p from '@clack/prompts';
import pc from 'picocolors';
import { execSync } from 'child_process';
import { spawnHidden } from '../../shared/spawn.js';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { loadCodexMemEnv, saveCodexMemEnv } from '../../shared/EnvManager.js';
import { ensureWorkerStarted, type WorkerStartResult } from '../../services/worker-spawner.js';
import {
  ensureBun,
  ensureUv,
  installPluginDependencies,
  writeInstallMarker,
  isInstallCurrent,
} from '../install/setup-runtime.js';
import { playBanner } from '../banner.js';

function getSetting<K extends keyof SettingsDefaults>(key: K): SettingsDefaults[K] {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)[key];
}

const isInteractive = process.stdin.isTTY === true;

interface TaskDescriptor {
  title: string;
  task: (message: (msg: string) => void) => Promise<string>;
}

async function runTasks(tasks: TaskDescriptor[]): Promise<void> {
  if (isInteractive) {
    await p.tasks(tasks);
  } else {
    for (const t of tasks) {
      const result = await t.task((msg: string) => console.log(`  ${msg}`));
      console.log(`  ${result}`);
    }
  }
}

async function bufferConsole<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  if (!isInteractive) {
    const result = await fn();
    return { result, output: '' };
  }
  let buffer = '';
  const append = (...args: unknown[]) => {
    buffer += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
  };
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = append;
  console.error = append;
  console.warn = append;
  try {
    const result = await fn();
    return { result, output: buffer };
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
  }
}

const log = {
  info: (msg: string) => isInteractive ? p.log.info(msg) : console.log(`  ${msg}`),
  success: (msg: string) => isInteractive ? p.log.success(msg) : console.log(`  ${msg}`),
  warn: (msg: string) => isInteractive ? p.log.warn(msg) : console.warn(`  ${msg}`),
  error: (msg: string) => isInteractive ? p.log.error(msg) : console.error(`  ${msg}`),
};
import {
  codexSettingsPath,
  ensureDirectoryExists,
  installedPluginsPath,
  IS_WINDOWS,
  knownMarketplacesPath,
  marketplaceDirectory,
  npmPackagePluginDirectory,
  npmPackageRootDirectory,
  pluginCacheDirectory,
  pluginsDirectory,
  readPluginVersion,
  writeJsonFileAtomic,
} from '../utils/paths.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { shutdownWorkerAndWait } from '../../services/install/shutdown-helper.js';
import { detectInstalledIDEs } from './ide-detection.js';

function registerMarketplace(): void {
  const knownMarketplaces = readJsonSafe<Record<string, any>>(knownMarketplacesPath(), {});

  knownMarketplaces['thedotmack'] = {
    source: {
      source: 'github',
      repo: 'thedotmack/codex-mem',
    },
    installLocation: marketplaceDirectory(),
    lastUpdated: new Date().toISOString(),
    autoUpdate: true,
  };

  ensureDirectoryExists(pluginsDirectory());
  writeJsonFileAtomic(knownMarketplacesPath(), knownMarketplaces);
}

function registerPlugin(version: string): void {
  const installedPlugins = readJsonSafe<Record<string, any>>(installedPluginsPath(), {});

  if (!installedPlugins.version) installedPlugins.version = 2;
  if (!installedPlugins.plugins) installedPlugins.plugins = {};

  const cachePath = pluginCacheDirectory(version);
  const now = new Date().toISOString();

  installedPlugins.plugins['codex-mem@thedotmack'] = [
    {
      scope: 'user',
      installPath: cachePath,
      version,
      installedAt: now,
      lastUpdated: now,
    },
  ];

  writeJsonFileAtomic(installedPluginsPath(), installedPlugins);
}

function enablePluginInCodexSettings(): void {
  const settings = readJsonSafe<Record<string, any>>(codexSettingsPath(), {});

  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  settings.enabledPlugins['codex-mem@thedotmack'] = true;

  writeJsonFileAtomic(codexSettingsPath(), settings);
}

/**
 * Disable Codex Code's built-in auto-memory by setting CODEX_CODE_DISABLE_AUTO_MEMORY=1
 * in ~/.codex/settings.json `env` block. codex-mem provides its own persistent memory
 * via plugin hooks; the built-in MEMORY.md system creates shadow state outside the user's
 * control and competes with codex-mem for context window tokens.
 *
 * Per codexs/codex-code#23544, the env var is the only supported toggle.
 *
 * Idempotent: only writes when not already set, preserves existing env vars and other
 * settings keys, and merges atomically. Returns true when a write happened (for the
 * caller to surface in the install summary).
 */
export function disableCodexAutoMemory(): boolean {
  const settings = readJsonSafe<Record<string, any>>(codexSettingsPath(), {});
  const env = (settings.env && typeof settings.env === 'object') ? settings.env : {};

  if (env.CODEX_CODE_DISABLE_AUTO_MEMORY === '1') {
    return false;
  }

  settings.env = { ...env, CODEX_CODE_DISABLE_AUTO_MEMORY: '1' };
  writeJsonFileAtomic(codexSettingsPath(), settings);
  return true;
}

function makeIDETask(ideId: string, failedIDEs: string[], pendingErrors: string[]): TaskDescriptor | null {
  const recordFailure = (label: string, output: string) => {
    failedIDEs.push(ideId);
    if (output && output.trim().length > 0) {
      pendingErrors.push(`${label}\n${output.trim()}`);
    }
  };

  switch (ideId) {
    case 'codex-code': {
      return {
        title: 'Codex Code: registering plugin',
        task: async () => `Codex Code: plugin registered ${pc.green('OK')}`,
      };
    }

    case 'cursor': {
      return {
        title: 'Cursor: installing hooks + MCP',
        task: async (message) => {
          message('Loading Cursor installer…');
          const { installCursorHooks, configureCursorMcp } = await import('../../services/integrations/CursorHooksInstaller.js');
          message('Installing Cursor hooks…');
          const { result: cursorResult, output: hooksOutput } = await bufferConsole(() => installCursorHooks('user'));
          if (cursorResult !== 0) {
            recordFailure('Cursor: hook installation failed', hooksOutput);
            return `Cursor: hook installation failed ${pc.red('FAIL')}`;
          }
          message('Configuring Cursor MCP…');
          const { result: mcpResult } = await bufferConsole(async () => configureCursorMcp('user'));
          if (mcpResult === 0) {
            return `Cursor: hooks + MCP installed ${pc.green('OK')}`;
          }
          return `Cursor: hooks installed; MCP setup failed — run \`npx codex-mem cursor mcp\` ${pc.yellow('!')}`;
        },
      };
    }

    case 'gemini-cli': {
      return {
        title: 'Gemini CLI: installing hooks',
        task: async (message) => {
          message('Loading Gemini CLI installer…');
          const { installGeminiCliHooks } = await import('../../services/integrations/GeminiCliHooksInstaller.js');
          message('Installing Gemini CLI hooks…');
          const { result, output } = await bufferConsole(() => installGeminiCliHooks());
          if (result !== 0) {
            recordFailure('Gemini CLI: hook installation failed', output);
            return `Gemini CLI: hook installation failed ${pc.red('FAIL')}`;
          }
          return `Gemini CLI: hooks installed ${pc.green('OK')}`;
        },
      };
    }

    case 'opencode': {
      return {
        title: 'OpenCode: installing plugin',
        task: async (message) => {
          message('Loading OpenCode installer…');
          const { installOpenCodeIntegration } = await import('../../services/integrations/OpenCodeInstaller.js');
          message('Installing OpenCode plugin…');
          const { result, output } = await bufferConsole(() => installOpenCodeIntegration());
          if (result !== 0) {
            recordFailure('OpenCode: plugin installation failed', output);
            return `OpenCode: plugin installation failed ${pc.red('FAIL')}`;
          }
          return `OpenCode: plugin installed ${pc.green('OK')}`;
        },
      };
    }

    case 'windsurf': {
      return {
        title: 'Windsurf: installing hooks',
        task: async (message) => {
          message('Loading Windsurf installer…');
          const { installWindsurfHooks } = await import('../../services/integrations/WindsurfHooksInstaller.js');
          message('Installing Windsurf hooks…');
          const { result, output } = await bufferConsole(() => installWindsurfHooks());
          if (result !== 0) {
            recordFailure('Windsurf: hook installation failed', output);
            return `Windsurf: hook installation failed ${pc.red('FAIL')}`;
          }
          return `Windsurf: hooks installed ${pc.green('OK')}`;
        },
      };
    }

    case 'openclaw': {
      return {
        title: 'OpenClaw: installing plugin',
        task: async (message) => {
          message('Loading OpenClaw installer…');
          const { installOpenClawIntegration } = await import('../../services/integrations/OpenClawInstaller.js');
          message('Copying plugin files…');
          const { result, output } = await bufferConsole(() => installOpenClawIntegration());
          if (result !== 0) {
            recordFailure('OpenClaw: plugin installation failed', output);
            return `OpenClaw: plugin installation failed ${pc.red('FAIL')}`;
          }
          return `OpenClaw: plugin installed ${pc.green('OK')}`;
        },
      };
    }

    case 'codex-cli': {
      return {
        title: 'Codex CLI: registering hooks marketplace',
        task: async (message) => {
          message('Loading Codex CLI installer…');
          const { installCodexCli } = await import('../../services/integrations/CodexCliInstaller.js');
          message('Registering native Codex hooks…');
          const { result, output } = await bufferConsole(() => installCodexCli(marketplaceDirectory()));
          if (result !== 0) {
            recordFailure('Codex CLI: integration setup failed', output);
            return `Codex CLI: integration setup failed ${pc.red('FAIL')}`;
          }
          return `Codex CLI: hooks marketplace registered ${pc.green('OK')}`;
        },
      };
    }

    case 'copilot-cli':
    case 'antigravity':
    case 'goose':
    case 'roo-code':
    case 'warp': {
      const allIDEs = detectInstalledIDEs();
      const ideInfo = allIDEs.find((i) => i.id === ideId);
      const ideLabel = ideInfo?.label ?? ideId;
      return {
        title: `${ideLabel}: installing MCP integration`,
        task: async (message) => {
          message('Loading MCP installer…');
          const { MCP_IDE_INSTALLERS } = await import('../../services/integrations/McpIntegrations.js');
          const mcpInstaller = MCP_IDE_INSTALLERS[ideId];
          if (!mcpInstaller) {
            return `${ideLabel}: MCP installer not found ${pc.yellow('!')}`;
          }
          message(`Configuring ${ideLabel} MCP…`);
          const { result, output } = await bufferConsole(() => mcpInstaller());
          if (result !== 0) {
            recordFailure(`${ideLabel}: MCP integration failed`, output);
            return `${ideLabel}: MCP integration failed ${pc.red('FAIL')}`;
          }
          return `${ideLabel}: MCP integration installed ${pc.green('OK')}`;
        },
      };
    }

    default: {
      const allIDEs = detectInstalledIDEs();
      const ide = allIDEs.find((i) => i.id === ideId);
      if (ide && !ide.supported) {
        return {
          title: `${ide.label}: skipping`,
          task: async () => `${ide.label}: support coming soon ${pc.yellow('!')}`,
        };
      }
      return null;
    }
  }
}

async function setupIDEs(selectedIDEs: string[]): Promise<string[]> {
  const failedIDEs: string[] = [];
  const pendingErrors: string[] = [];

  const tasks: TaskDescriptor[] = [];
  for (const ideId of selectedIDEs) {
    const taskDescriptor = makeIDETask(ideId, failedIDEs, pendingErrors);
    if (taskDescriptor) tasks.push(taskDescriptor);
  }

  if (tasks.length > 0) {
    await runTasks(tasks);
  }

  for (const errorBlock of pendingErrors) {
    log.warn(errorBlock);
  }

  return failedIDEs;
}

function detectShellConfigFile(): { path: string; shell: 'zsh' | 'bash' | 'fish' } {
  const home = homedir();
  const shellEnv = process.env.SHELL ?? '';

  if (shellEnv.includes('fish')) {
    return { path: join(home, '.config', 'fish', 'config.fish'), shell: 'fish' };
  }
  if (shellEnv.includes('zsh')) {
    return { path: join(home, '.zshrc'), shell: 'zsh' };
  }
  if (process.platform === 'darwin') {
    const bashProfile = join(home, '.bash_profile');
    if (existsSync(bashProfile)) return { path: bashProfile, shell: 'bash' };
  }
  return { path: join(home, '.bashrc'), shell: 'bash' };
}

function applyCodexCodePathSetupIfNeeded(): void {
  const home = homedir();
  const codexBinDir = join(home, '.local', 'bin');
  const codexBinary = join(codexBinDir, 'codex');

  if (!existsSync(codexBinary)) return;

  const currentPath = process.env.PATH ?? '';
  const pathEntries = currentPath.split(':');
  if (pathEntries.includes(codexBinDir)) return;

  const { path: configFile, shell } = detectShellConfigFile();
  const binPathLiteral = '$HOME/.local/bin';
  const exportLine = shell === 'fish'
    ? `set -gx PATH ${codexBinDir} $PATH`
    : `export PATH="${binPathLiteral}:$PATH"`;

  let existing = '';
  if (existsSync(configFile)) {
    try {
      existing = readFileSync(configFile, 'utf-8');
    } catch (error: unknown) {
      log.warn(`Could not read ${configFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    try {
      mkdirSync(dirname(configFile), { recursive: true });
    } catch {
      // Best-effort directory creation.
    }
  }

  if (existing.includes(codexBinDir) || existing.includes(binPathLiteral)) {
    log.info(`Codex Code PATH already configured in ${configFile}`);
  } else {
    try {
      const trailing = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
      const block = `${trailing}\n# Added by codex-mem installer for Codex Code\n${exportLine}\n`;
      writeFileSync(configFile, existing + block, 'utf-8');
      log.success(`Added Codex Code to PATH in ${configFile}`);
    } catch (error: unknown) {
      log.warn(`Could not update ${configFile}: ${error instanceof Error ? error.message : String(error)}`);
      log.info(`Run manually: echo '${exportLine}' >> ${configFile}`);
      return;
    }
  }

  process.env.PATH = `${codexBinDir}:${currentPath}`;
}

async function installCodexCode(): Promise<boolean> {
  const command = IS_WINDOWS
    ? 'powershell -ExecutionPolicy ByPass -c "irm https://codex.ai/install.ps1 | iex"'
    : 'curl -fsSL https://codex.ai/install.sh | bash';

  const spinner = isInteractive ? p.spinner() : null;
  spinner?.start('Installing Codex Code (this can take a few minutes — downloading the native build)…');

  return new Promise<boolean>((resolve) => {
    let captured = '';
    const child = spawnHidden(command, [], {
      shell: IS_WINDOWS ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/bash',
      stdio: spinner ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    });

    child.stdout?.on('data', (chunk: Buffer) => { captured += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { captured += chunk.toString(); });

    child.on('error', (error: Error) => {
      spinner?.stop('Codex Code install failed');
      if (captured) process.stderr.write(captured);
      log.error(`Codex Code install failed: ${error.message}`);
      log.info('You can install it manually later: https://codex.ai/install.sh');
      resolve(false);
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        spinner?.stop('Codex Code install failed');
        if (captured) process.stderr.write(captured);
        log.error(`Codex Code install failed (exit ${code ?? 'unknown'})`);
        log.info('You can install it manually later: https://codex.ai/install.sh');
        resolve(false);
        return;
      }
      spinner?.stop('Codex Code installed');
      if (!IS_WINDOWS) {
        try {
          applyCodexCodePathSetupIfNeeded();
        } catch (error: unknown) {
          log.warn(`Could not auto-apply PATH setup: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      resolve(true);
    });
  });
}

async function promptForIDESelection(): Promise<string[]> {
  let detectedIDEs = detectInstalledIDEs();
  const codexCodeInfo = detectedIDEs.find((ide) => ide.id === 'codex-code');

  if (codexCodeInfo && !codexCodeInfo.detected) {
    log.warn('Codex Code is not installed. Codex-mem works best in Codex Code, but also works with the IDEs below.');
    const choice = await p.select<'install' | 'skip' | 'cancel'>({
      message: 'Install Codex Code now?',
      options: [
        { value: 'install', label: 'Yes — install Codex Code (recommended)' },
        { value: 'skip', label: 'No — pick another IDE below' },
        { value: 'cancel', label: 'Cancel installation' },
      ],
      initialValue: 'install',
    });
    if (p.isCancel(choice) || choice === 'cancel') {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }
    if (choice === 'install') {
      if (await installCodexCode()) {
        detectedIDEs = detectInstalledIDEs();
      }
    }
  }

  const detected = detectedIDEs.filter((ide) => ide.detected);

  if (detected.length === 0) {
    log.warn('No supported IDEs detected — pick the one(s) you plan to use.');
  }

  const options = detectedIDEs.map((ide) => {
    const detectedTag = ide.detected ? ' [detected]' : '';
    const hint = ide.supported ? `${ide.hint}${detectedTag}` : `coming soon${detectedTag}`;
    return {
      value: ide.id,
      label: ide.label,
      hint,
    };
  });

  const result = await p.multiselect({
    message: 'Which IDEs do you use?',
    options,
    initialValues: [],
    required: true,
  });

  if (p.isCancel(result)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  return result as string[];
}

function copyPluginToMarketplace(): void {
  const marketplaceDir = marketplaceDirectory();
  const packageRoot = npmPackageRootDirectory();

  ensureDirectoryExists(marketplaceDir);

  const allowedTopLevelEntries = [
    '.agents',
    '.codex-plugin',
    'plugin',
    'package.json',
    'package-lock.json',
    'openclaw',
    'dist',
    'LICENSE',
    'README.md',
    'CHANGELOG.md',
  ];

  for (const entry of allowedTopLevelEntries) {
    const sourcePath = join(packageRoot, entry);
    const destPath = join(marketplaceDir, entry);
    if (!existsSync(sourcePath)) continue;

    if (existsSync(destPath)) {
      rmSync(destPath, { recursive: true, force: true });
    }
    cpSync(sourcePath, destPath, {
      recursive: true,
      force: true,
    });
  }
}

function copyPluginToCache(version: string): void {
  const sourcePluginDirectory = npmPackagePluginDirectory();
  const cachePath = pluginCacheDirectory(version);

  rmSync(cachePath, { recursive: true, force: true });
  ensureDirectoryExists(cachePath);
  cpSync(sourcePluginDirectory, cachePath, { recursive: true, force: true });
}

function runNpmInstallInMarketplace(): void {
  const marketplaceDir = marketplaceDirectory();
  const packageJsonPath = join(marketplaceDir, 'package.json');

  if (!existsSync(packageJsonPath)) return;

  // --legacy-peer-deps suppresses a known false-positive ERESOLVE between
  // tree-sitter@0.21 and @tree-sitter-grammars/* peer ranges. The native
  // bindings path is unused (we load .wasm), so the conflict is benign.
  // Revisit if real peer constraints are added to the marketplace deps.
  execSync('npm install --omit=dev --legacy-peer-deps', {
    cwd: marketplaceDir,
    stdio: 'pipe',
    encoding: 'utf8',
    ...(IS_WINDOWS ? { shell: process.env.ComSpec ?? 'cmd.exe' } : {}),
  });
}

function mergeSettings(updates: Record<string, string>): boolean {
  const path = USER_SETTINGS_PATH;
  try {
    let current: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.env && typeof parsed.env === 'object') {
          current = { ...parsed.env };
        } else if (parsed && typeof parsed === 'object') {
          current = { ...parsed };
        }
      } catch (parseError: unknown) {
        console.warn('[install] Failed to parse existing settings.json, starting from empty:', parseError instanceof Error ? parseError.message : String(parseError));
        current = {};
      }
    } else {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    for (const [key, value] of Object.entries(updates)) {
      current[key] = value;
    }

    writeFileSync(path, JSON.stringify(current, null, 2), 'utf-8');
    return true;
  } catch (error: unknown) {
    log.error(`Failed to write settings to ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

type ProviderId = 'codex' | 'gemini' | 'openrouter';
type CodexAccessMode = 'subscription' | 'api-key';
type CodexApiMode = 'direct' | 'gateway';
type RuntimeId = 'worker' | 'server-beta';

function readRawStoredAuthMethod(): 'subscription' | 'api-key' | 'gateway' | undefined {
  try {
    if (!existsSync(USER_SETTINGS_PATH)) return undefined;
    const raw = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
    const flat = (raw.env && typeof raw.env === 'object' ? raw.env : raw) as Record<string, unknown>;
    const value = flat.CODEX_MEM_CODEX_AUTH_METHOD;
    if (value === 'subscription' || value === 'api-key' || value === 'gateway') return value;
    return undefined;
  } catch {
    return undefined;
  }
}

function resolveCodexAuthMethod(): 'subscription' | 'api-key' | 'gateway' {
  const stored = readRawStoredAuthMethod();
  if (stored) return stored;
  const env = loadCodexMemEnv();
  if (env.CODEX_BASE_URL?.trim()) return 'gateway';
  if (env.CODEX_API_KEY?.trim()) return 'api-key';
  return 'subscription';
}

async function promptRuntime(): Promise<RuntimeId> {
  if (!isInteractive) {
    mergeSettings({ CODEX_MEM_RUNTIME: 'worker' });
    return 'worker';
  }

  const selected = await p.select<RuntimeId>({
    message: 'Which runtime should codex-mem start after install?',
    options: [
      { value: 'worker', label: 'Worker', hint: 'stable compatibility path' },
      { value: 'server-beta', label: 'Server (beta)', hint: 'REST V1, API keys, team-ready storage' },
    ],
    initialValue: 'worker',
  });

  if (p.isCancel(selected)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  mergeSettings({
    CODEX_MEM_RUNTIME: selected,
  });

  if (selected === 'server-beta') {
    await maybeBootstrapServerBetaApiKey();
  }
  return selected;
}

async function maybeBootstrapServerBetaApiKey(): Promise<void> {
  // Only attempt if Postgres is configured. Without DATABASE_URL we cannot
  // reach the api_keys table — the operator must configure the server first
  // and rerun `codex-mem server keys rotate`.
  if (!process.env.CODEX_MEM_SERVER_DATABASE_URL) {
    log.warn(
      'Skipping local hook API key bootstrap: CODEX_MEM_SERVER_DATABASE_URL is not set. '
        + 'Run `npx codex-mem server keys rotate` after configuring Postgres to provision a key.',
    );
    return;
  }
  try {
    const { bootstrapServerBetaApiKey, persistServerBetaSettings } = await import(
      '../../services/hooks/server-beta-bootstrap.js'
    );
    const result = await bootstrapServerBetaApiKey();
    persistServerBetaSettings(USER_SETTINGS_PATH, {
      apiKey: result.rawKey,
      projectId: result.projectId,
    });
    log.info(
      `Provisioned local hook API key (project=${result.projectId.slice(0, 8)}…). `
        + 'Settings saved with mode 0600.',
    );
  } catch (error: unknown) {
    log.warn(
      `Failed to bootstrap server-beta API key: ${error instanceof Error ? error.message : String(error)}. `
        + 'Hooks will fall back to the worker until you run `npx codex-mem server keys rotate`.',
    );
  }
}

async function promptProvider(options: InstallOptions): Promise<ProviderId> {
  const initialProvider = (getSetting('CODEX_MEM_PROVIDER') as ProviderId) || 'codex';

  const persistCodexProvider = (authMethod?: 'subscription' | 'api-key' | 'gateway') => {
    const resolvedAuthMethod = authMethod ?? resolveCodexAuthMethod();
    const wrote = mergeSettings({
      CODEX_MEM_PROVIDER: 'codex',
      CODEX_MEM_CODEX_AUTH_METHOD: resolvedAuthMethod,
    });
    if (wrote) log.info('Saved Codex CLI configuration to ~/.codex-mem/settings.json');
  };

  const useSubscriptionAuth = () => {
    persistCodexProvider('subscription');
    saveCodexMemEnv({
      CODEX_API_KEY: '',
      CODEX_BASE_URL: '',
      CODEX_AUTH_TOKEN: '',
    });
    log.info('Configured codex-mem to use your logged-in Codex CLI account.');
  };

  const configureDirectApiKey = async (): Promise<void> => {
    const existing = loadCodexMemEnv().CODEX_API_KEY || '';
    if (existing.trim().length > 0) {
      const choice = await p.select<'keep' | 'replace'>({
        message: 'An Codex API key is already configured. Keep it or enter a new one?',
        options: [
          { value: 'keep', label: 'Keep existing key' },
          { value: 'replace', label: 'Enter a new key (rotate)' },
        ],
        initialValue: 'keep',
      });
      if (p.isCancel(choice)) {
        log.warn('API key prompt cancelled — leaving existing configuration untouched.');
        return;
      }
      if (choice === 'keep') {
        saveCodexMemEnv({
          CODEX_API_KEY: existing.trim(),
          CODEX_BASE_URL: '',
          CODEX_AUTH_TOKEN: '',
        });
        persistCodexProvider('api-key');
        return;
      }
    }

    const apiKeyResult = await p.password({
      message: 'Paste your Codex API key:',
      mask: '*',
      validate: (v?: string) => (!v || v.trim().length === 0) ? 'API key required' : undefined,
    });

    if (p.isCancel(apiKeyResult)) {
      log.warn('API key prompt cancelled — leaving existing configuration untouched.');
      return;
    }

    saveCodexMemEnv({
      CODEX_API_KEY: String(apiKeyResult).trim(),
      CODEX_BASE_URL: '',
      CODEX_AUTH_TOKEN: '',
    });
    persistCodexProvider('api-key');
    log.info('Saved Codex API key for the Codex CLI path.');
  };

  const configureGateway = async (): Promise<void> => {
    const existing = loadCodexMemEnv();
    const baseUrlResult = await p.text({
      message: 'Gateway URL:',
      placeholder: existing.CODEX_BASE_URL || 'http://localhost:4000',
      defaultValue: existing.CODEX_BASE_URL || '',
      validate: (v?: string) => {
        const value = v?.trim() ?? '';
        if (!value) return 'Gateway URL required';
        try {
          new URL(value);
          return undefined;
        } catch {
          return 'Enter a valid URL, for example http://localhost:4000';
        }
      },
    });

    if (p.isCancel(baseUrlResult)) {
      log.warn('Gateway setup cancelled — leaving existing configuration untouched.');
      return;
    }

    const tokenResult = await p.password({
      message: 'Gateway key/token (leave blank to keep current token, or type a new one):',
      mask: '*',
    });

    const tokenCancelled = p.isCancel(tokenResult);
    const tokenInput = tokenCancelled ? '' : String(tokenResult).trim();
    const env: Record<string, string> = {
      CODEX_API_KEY: '',
      CODEX_BASE_URL: String(baseUrlResult).trim(),
    };
    if (!tokenCancelled && tokenInput.length > 0) {
      env.CODEX_AUTH_TOKEN = tokenInput;
    }
    saveCodexMemEnv(env);
    persistCodexProvider('gateway');
    if (tokenCancelled || tokenInput.length === 0) {
      log.info('Gateway URL saved; existing gateway token preserved.');
    } else {
      log.info('Configured Codex CLI gateway in ~/.codex-mem/.env.');
    }
  };

  if (!isInteractive) {
    if (options.provider) {
      if (options.provider === 'codex') {
        persistCodexProvider();
        return 'codex';
      }
      const wrote = mergeSettings({ CODEX_MEM_PROVIDER: options.provider });
      if (wrote) log.info(`Saved provider=${options.provider} to ~/.codex-mem/settings.json`);
      log.warn(`Provider=${options.provider} requested non-interactively. API key prompt skipped — set CODEX_MEM_${options.provider.toUpperCase()}_API_KEY and CODEX_MEM_PROVIDER in settings.json or env manually if not already set.`);
      return options.provider;
    }
    return initialProvider;
  }

  const runCodexAuthFlow = async (): Promise<void> => {
    const resolvedAuthMethod = resolveCodexAuthMethod();
    const initialAccessMode: CodexAccessMode =
      resolvedAuthMethod === 'subscription' ? 'subscription' : 'api-key';

    const result = await p.select<CodexAccessMode>({
      message: 'Do you use a subscription plan or an API key/gateway for the memory agent?',
      options: [
        { value: 'subscription', label: 'Subscription plan (recommended — uses your logged-in Codex CLI account)' },
        { value: 'api-key', label: 'API key or gateway (Codex, LiteLLM, or compatible proxy)' },
      ],
      initialValue: initialAccessMode,
    });

    if (p.isCancel(result)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }
    if (result === 'subscription') {
      useSubscriptionAuth();
      return;
    }

    const apiModeResult = await p.select<CodexApiMode>({
      message: 'How should codex-mem connect?',
      options: [
        { value: 'direct', label: 'Codex API key' },
        { value: 'gateway', label: 'LiteLLM or custom gateway' },
      ],
      initialValue: resolvedAuthMethod === 'gateway' || loadCodexMemEnv().CODEX_BASE_URL ? 'gateway' : 'direct',
    });

    if (p.isCancel(apiModeResult)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    if (apiModeResult === 'gateway') {
      await configureGateway();
    } else {
      await configureDirectApiKey();
    }
  };

  let selectedProvider: ProviderId;
  if (options.provider) {
    selectedProvider = options.provider;
  } else {
    const providerResult = await p.select<ProviderId>({
      message: 'Which memory provider do you want to use?',
      options: [
        { value: 'codex', label: 'Codex CLI (recommended)' },
        { value: 'gemini', label: 'Gemini' },
        { value: 'openrouter', label: 'OpenRouter' },
      ],
      initialValue: initialProvider,
    });
    if (p.isCancel(providerResult)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }
    selectedProvider = providerResult;
  }

  if (selectedProvider === 'codex') {
    await runCodexAuthFlow();
    return 'codex';
  }

  const providerLabel = selectedProvider === 'gemini' ? 'Gemini' : 'OpenRouter';
  const keyEnvName = selectedProvider === 'gemini'
    ? 'CODEX_MEM_GEMINI_API_KEY'
    : 'CODEX_MEM_OPENROUTER_API_KEY';

  const existingKey = getSetting(keyEnvName as keyof SettingsDefaults) as string | undefined;
  if (existingKey && existingKey.trim().length > 0) {
    const wrote = mergeSettings({ CODEX_MEM_PROVIDER: selectedProvider });
    if (wrote) log.info(`Saved provider=${selectedProvider} to ~/.codex-mem/settings.json`);
    return selectedProvider;
  }

  const apiKeyResult = await p.password({
    message: `Paste your ${providerLabel} API key:`,
    mask: '*',
    validate: (v?: string) => (!v || v.trim().length === 0) ? 'API key required' : undefined,
  });

  if (p.isCancel(apiKeyResult)) {
    log.warn(`API key prompt cancelled — falling back to Codex provider.`);
    persistCodexProvider();
    return 'codex';
  }

  const apiKey = String(apiKeyResult).trim();
  const wrote = mergeSettings({
    CODEX_MEM_PROVIDER: selectedProvider,
    [keyEnvName]: apiKey,
  });
  if (wrote) {
    log.info(`Saved provider=${selectedProvider} to ~/.codex-mem/settings.json`);
  }
  return selectedProvider;
}

async function promptCodexModel(options: InstallOptions): Promise<void> {
  const allowed = new Set([
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
  ]);
  const allowCustomModel = resolveCodexAuthMethod() === 'gateway';

  if (options.model && !allowCustomModel) {
    if (!allowed.has(options.model)) {
      throw new Error(
        `Unknown Codex model: ${options.model}. Allowed: ${[...allowed].join(', ')}`,
      );
    }
    const wrote = mergeSettings({ CODEX_MEM_MODEL: options.model });
    if (wrote) {
      log.info(`Saved Codex model=${options.model} to ~/.codex-mem/settings.json`);
    }
    return;
  }
  if (options.model && allowCustomModel) {
    const wrote = mergeSettings({ CODEX_MEM_MODEL: options.model });
    if (wrote) {
      log.info(`Saved gateway model=${options.model} to ~/.codex-mem/settings.json`);
    }
    return;
  }

  if (!isInteractive) return;

  const initialModel = getSetting('CODEX_MEM_MODEL');

  if (allowCustomModel) {
    const result = await p.text({
      message: 'Which model should the gateway use?',
      placeholder: 'gpt-5',
      defaultValue: initialModel || 'gpt-5',
      validate: (v?: string) => (!v || v.trim().length === 0) ? 'Model required' : undefined,
    });

    if (p.isCancel(result)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    const selectedModel = String(result).trim();
    const wrote = mergeSettings({ CODEX_MEM_MODEL: selectedModel });
    if (wrote) {
      log.info(`Saved gateway model=${selectedModel} to ~/.codex-mem/settings.json`);
    }
    return;
  }

  const initialValue = allowed.has(initialModel) ? initialModel : 'gpt-5';

  const result = await p.select<string>({
    message: 'Which Codex model should codex-mem use to compress observations?\nThis runs whenever you and Codex touch a file — keep it cheap and fast.',
    options: [
      { value: 'gpt-5', label: 'gpt-5 (recommended default)' },
      { value: 'gpt-5-mini', label: 'gpt-5-mini (fast, lower cost)' },
      { value: 'gpt-5-nano', label: 'gpt-5-nano (small, lowest cost)' },
    ],
    initialValue,
  });

  if (p.isCancel(result)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }
  const selectedModel = result as string;

  const wrote = mergeSettings({ CODEX_MEM_MODEL: selectedModel });
  if (wrote) {
    log.info(`Saved Codex model=${selectedModel} to ~/.codex-mem/settings.json`);
  }
}

export interface InstallOptions {
  ide?: string;
  provider?: 'codex' | 'gemini' | 'openrouter';
  model?: string;
  noAutoStart?: boolean;
}

export async function runInstallCommand(options: InstallOptions = {}): Promise<void> {
  const version = readPluginVersion();

  if (isInteractive) {
    await playBanner();
    p.intro(pc.bgCyan(pc.black(' codex-mem install ')));
  } else {
    console.log('codex-mem install');
  }
  const marketplaceDir = marketplaceDirectory();
  const alreadyInstalled = existsSync(join(marketplaceDir, 'plugin', '.codex-legacy-plugin', 'plugin.json'));

  let existingVersion: string | undefined;
  if (alreadyInstalled) {
    try {
      const existingPluginJson = JSON.parse(
        readFileSync(join(marketplaceDir, 'plugin', '.codex-legacy-plugin', 'plugin.json'), 'utf-8'),
      );
      existingVersion = existingPluginJson.version ?? undefined;
    } catch (error: unknown) {
      console.warn('[install] Failed to read existing plugin version:', error instanceof Error ? error.message : String(error));
    }
  }

  const dot = pc.dim('·');
  const segments = [`${pc.bold('codex-mem')} ${pc.cyan(`v${version}`)}`];
  if (existingVersion && existingVersion !== version) {
    segments.push(`installed ${pc.yellow(`v${existingVersion}`)}`);
  } else if (existingVersion) {
    segments.push(pc.dim('reinstall'));
  }
  log.info(segments.join(` ${dot} `));

  if (alreadyInstalled) {
    if (process.stdin.isTTY) {
      const shouldContinue = await p.confirm({
        message: 'Overwrite existing installation?',
        initialValue: true,
      });

      if (p.isCancel(shouldContinue) || !shouldContinue) {
        p.cancel('Installation cancelled.');
        process.exit(0);
      }
    }
  }

  let selectedIDEs: string[];
  if (options.ide) {
    selectedIDEs = [options.ide];
    const allIDEs = detectInstalledIDEs();
    const match = allIDEs.find((i) => i.id === options.ide);
    if (match && !match.supported) {
      log.error(`Support for ${match.label} coming soon.`);
      process.exit(1);
    }
    if (!match) {
      log.error(`Unknown IDE: ${options.ide}`);
      log.info(`Available IDEs: ${allIDEs.map((i) => i.id).join(', ')}`);
      process.exit(1);
    }
  } else if (process.stdin.isTTY) {
    selectedIDEs = await promptForIDESelection();
  } else {
    selectedIDEs = ['codex-code'];
  }

  const selectedRuntime = await promptRuntime();
  const selectedProvider = await promptProvider(options);
  if (selectedProvider === 'codex') {
    await promptCodexModel(options);
  }

  let workerStartResult: WorkerStartResult = 'dead';
  // Codex Code consumes the marketplace plugin system directly, so any selection
  // (codex-code or otherwise) needs the marketplace + plugin registration steps.
  // The only time we'd skip is a hypothetical no-IDE install, which the prompt above
  // doesn't allow today.
  const needsMarketplace = selectedIDEs.length > 0;

  {
    if (needsMarketplace) {
      const installPort = getSetting('CODEX_MEM_WORKER_PORT');
      const shutdownSpinner = isInteractive ? p.spinner() : null;
      shutdownSpinner?.start('Stopping running worker (so we can overwrite cleanly)…');
      try {
        const result = await shutdownWorkerAndWait(installPort, 10000);
        if (shutdownSpinner) {
          shutdownSpinner.stop(
            result.workerWasRunning
              ? 'Stopped running worker before overwrite.'
              : 'No worker running — proceeding.',
          );
        } else if (result.workerWasRunning) {
          log.info('Stopped running worker before overwrite.');
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (shutdownSpinner) {
          shutdownSpinner.stop(`Pre-overwrite worker shutdown failed: ${message}`);
        } else {
          console.warn('[install] Pre-overwrite worker shutdown failed:', message);
        }
      }
    }

    const tasks: TaskDescriptor[] = [
      {
        title: 'Caching plugin version',
        task: async (message) => {
          message(`Caching v${version}...`);
          copyPluginToCache(version);
          return `Plugin cached (v${version}) ${pc.green('OK')}`;
        },
      },
      {
        title: 'Registering marketplace',
        task: async () => {
          registerMarketplace();
          return `Marketplace registered ${pc.green('OK')}`;
        },
      },
      {
        title: 'Registering plugin',
        task: async () => {
          registerPlugin(version);
          return `Plugin registered ${pc.green('OK')}`;
        },
      },
      {
        title: 'Enabling plugin in Codex settings',
        task: async () => {
          enablePluginInCodexSettings();
          return `Plugin enabled ${pc.green('OK')}`;
        },
      },
      {
        title: 'Setting up runtime (first install can take ~30s)',
        task: async (message) => {
          message('Checking Bun…');
          const { version: bunVersion } = await ensureBun();
          message('Checking uv…');
          const { version: uvVersion } = await ensureUv();
          const cacheDir = pluginCacheDirectory(version);
          if (!isInstallCurrent(cacheDir, version)) {
            message('Installing plugin dependencies…');
            const { bunPath } = await ensureBun();
            await installPluginDependencies(cacheDir, bunPath);
            writeInstallMarker(cacheDir, version, bunVersion, uvVersion);
          }
          return `Runtime ready (Bun ${bunVersion}, uv ${uvVersion}) ${pc.green('OK')}`;
        },
      },
    ];

    if (needsMarketplace) {
      tasks.unshift({
        title: 'Copying plugin files to marketplace',
        task: async (message) => {
          message('Copying to marketplace directory...');
          copyPluginToMarketplace();
          return `Plugin files copied ${pc.green('OK')}`;
        },
      });
      tasks.push({
        title: 'Installing marketplace dependencies',
        task: async (message) => {
          message('Running npm install...');
          try {
            runNpmInstallInMarketplace();
            return `Dependencies installed ${pc.green('OK')}`;
          } catch (error: unknown) {
            console.warn('[install] npm install error:', error instanceof Error ? error.message : String(error));
            return `Dependencies may need manual install ${pc.yellow('!')}`;
          }
        },
      });
    }

    await runTasks(tasks);
  }

  const failedIDEs = await setupIDEs(selectedIDEs);

  // Disable Codex Code's built-in auto-memory (CODEX_CODE_DISABLE_AUTO_MEMORY=1)
  // for any install that targets codex-code. codex-mem's hook-based memory is the
  // intended source of cross-session context; the built-in MEMORY.md system creates
  // shadow state and competes for context-window tokens.
  // Tri-state so the summary can distinguish "wrote", "already set", and "failed".
  // A boolean would conflate the error path with "already set", which is misleading
  // when a write fails mid-install (the warn would say one thing, the summary another).
  let autoMemoryStatus: 'disabled' | 'already-disabled' | 'failed' | null = null;
  if (selectedIDEs.includes('codex-code')) {
    try {
      const wrote = disableCodexAutoMemory();
      autoMemoryStatus = wrote ? 'disabled' : 'already-disabled';
      if (wrote) {
        log.success('Codex Code: auto-memory disabled (CODEX_CODE_DISABLE_AUTO_MEMORY=1).');
      } else {
        log.info('Codex Code: auto-memory already disabled, leaving settings.json untouched.');
      }
    } catch (error: unknown) {
      // Don't fail the install over this — surface the warning and continue.
      autoMemoryStatus = 'failed';
      log.warn(`Could not disable Codex Code auto-memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const autoStartSkipped = !isInteractive || options.noAutoStart;

  await runTasks([
    {
      title: selectedRuntime === 'server-beta' ? 'Starting server beta daemon' : 'Starting worker daemon',
      task: async (message) => {
        if (autoStartSkipped) {
          return isInteractive
            ? `Skipped (--no-auto-start)`
            : `Skipped (non-TTY)`;
        }
        const port = Number(getSetting('CODEX_MEM_WORKER_PORT'));
        const marketplaceScriptPath = join(marketplaceDirectory(), 'plugin', 'scripts', 'worker-service.cjs');
        const cacheScriptPath = join(pluginCacheDirectory(version), 'scripts', 'worker-service.cjs');
        const scriptPath = existsSync(marketplaceScriptPath) ? marketplaceScriptPath : cacheScriptPath;
        message(`Spawning ${selectedRuntime === 'server-beta' ? 'server beta' : 'worker'} on port ${port}...`);
        workerStartResult = await ensureWorkerStarted(port, scriptPath);
        switch (workerStartResult) {
          case 'ready':
            return `${selectedRuntime === 'server-beta' ? 'Server beta' : 'Worker'} ready at http://localhost:${port} ${pc.green('OK')}`;
          case 'warming':
            return `${selectedRuntime === 'server-beta' ? 'Server beta' : 'Worker'} starting on port ${port} — finishing in background ${pc.yellow('⏳')}`;
          case 'dead':
            return `${selectedRuntime === 'server-beta' ? 'Server beta' : 'Worker'} did not start — try \`${selectedRuntime === 'server-beta' ? 'npx codex-mem server start' : 'npx codex-mem start'}\` manually ${pc.yellow('!')}`;
        }
      },
    },
  ]);

  const installStatus = failedIDEs.length > 0 ? 'Installation Partial' : 'Installation Complete';
  const summaryLines = [
    `Version:     ${pc.cyan(version)}`,
    `Plugin dir:  ${pc.cyan(marketplaceDir)}`,
    `IDEs:        ${pc.cyan(selectedIDEs.join(', '))}`,
  ];
  if (autoMemoryStatus === 'disabled') {
    summaryLines.push(`Auto-memory: ${pc.cyan('disabled')} (CODEX_CODE_DISABLE_AUTO_MEMORY=1)`);
  } else if (autoMemoryStatus === 'already-disabled') {
    summaryLines.push(`Auto-memory: ${pc.cyan('already disabled')} (CODEX_CODE_DISABLE_AUTO_MEMORY=1)`);
  } else if (autoMemoryStatus === 'failed') {
    summaryLines.push(`Auto-memory: ${pc.red('write failed')} (see warning above)`);
  }
  if (failedIDEs.length > 0) {
    summaryLines.push(`Failed:      ${pc.red(failedIDEs.join(', '))}`);
  }

  if (isInteractive) {
    p.note(summaryLines.join('\n'), installStatus);
  } else {
    console.log(`\n  ${installStatus}`);
    summaryLines.forEach(l => console.log(`  ${l}`));
  }

  const workerPort = getSetting('CODEX_MEM_WORKER_PORT');

  let actualPort: number | string = workerPort;
  let workerReady = false;
  // Don't poll the worker or imply it's "still starting" when autostart was
  // intentionally skipped (--no-auto-start, or non-interactive default). The
  // user knows they have to start it themselves; lying about a starting worker
  // is misleading.
  if (!autoStartSkipped) {
    const healthSpinner = isInteractive ? p.spinner() : null;
    healthSpinner?.start(`Verifying worker on port ${workerPort}…`);
    try {
      const healthResponse = await fetch(`http://127.0.0.1:${workerPort}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (healthResponse.ok) {
        workerReady = true;
        try {
          const body = await healthResponse.json() as { port?: number | string };
          if (body && (typeof body.port === 'number' || typeof body.port === 'string')) {
            actualPort = body.port;
          }
        } catch {
          // Health endpoint returned non-JSON — keep using the requested port.
        }
      }
      healthSpinner?.stop(
        workerReady
          ? `Worker ready at http://localhost:${actualPort}`
          : `Worker reachable but not ready on port ${workerPort}`,
      );
    } catch {
      healthSpinner?.stop(`Worker not yet responding on port ${workerPort} (still starting)`);
    }
  }

  const finalWorkerState = workerStartResult as WorkerStartResult;
  const workerAlive = finalWorkerState !== 'dead' || workerReady;
  const runtimeLabel = selectedRuntime === 'server-beta' ? 'Server beta' : 'Worker';
  const runtimeStartCommand = selectedRuntime === 'server-beta' ? 'npx codex-mem server start' : 'npx codex-mem start';
  const workerHeadline = autoStartSkipped
    ? `${pc.yellow('!')} ${runtimeLabel} autostart skipped — start it manually with ${pc.bold(runtimeStartCommand)}`
    : workerReady || finalWorkerState === 'ready'
      ? `${pc.green('✓')} ${runtimeLabel} running at ${pc.underline(`http://localhost:${actualPort}`)}`
      : `${pc.yellow('⏳')} ${runtimeLabel} starting at ${pc.underline(`http://localhost:${actualPort}`)} — give it ~30s, then refresh`;
  const nextSteps = autoStartSkipped
    ? [
        workerHeadline,
        ``,
        `${pc.bold('First success:')} once the worker is running, keep ${pc.underline(`http://localhost:${workerPort}`)} open in a browser, then open Codex Code in any project. Observations stream in as Codex reads, edits, and runs commands.`,
        ``,
        `${pc.bold('Two paths from here:')}`,
        `  ${pc.cyan('A.')} Just start working. Memory builds passively from your first prompt. (Recommended.)`,
        `  ${pc.cyan('B.')} Front-load it: open Codex Code and run ${pc.bold('/learn-codebase')} to ingest the whole repo (~5 min, optional).`,
        ``,
        `Memory injection starts on your second session in a project.`,
        `Everything stays in ${pc.cyan('~/.codex-mem')} on this machine.`,
        ``,
        `${pc.dim('How it works: /how-it-works   ·   Disable first-session hint: CODEX_MEM_WELCOME_HINT_ENABLED=false')}`,
        `${pc.dim('Note: close all Codex Code sessions before uninstalling, or ~/.codex-mem will be recreated by active hooks.')}`,
      ]
    : workerAlive
    ? [
        workerHeadline,
        ``,
        `${pc.bold('First success:')} keep that URL open in a browser, then open Codex Code in any project. Observations stream in as Codex reads, edits, and runs commands.`,
        ``,
        `${pc.bold('Two paths from here:')}`,
        `  ${pc.cyan('A.')} Just start working. Memory builds passively from your first prompt. (Recommended.)`,
        `  ${pc.cyan('B.')} Front-load it: open Codex Code and run ${pc.bold('/learn-codebase')} to ingest the whole repo (~5 min, optional).`,
        ``,
        `Memory injection starts on your second session in a project.`,
        `Everything stays in ${pc.cyan('~/.codex-mem')} on this machine.`,
        ``,
        `${pc.dim('How it works: /how-it-works   ·   Disable first-session hint: CODEX_MEM_WELCOME_HINT_ENABLED=false')}`,
        `${pc.dim('Note: close all Codex Code sessions before uninstalling, or ~/.codex-mem will be recreated by active hooks.')}`,
      ]
    : [
        `${pc.yellow('!')} Worker not yet ready on port ${pc.cyan(String(workerPort))} -- still starting up; check ${pc.bold('codex-mem status')} later, or start manually: ${pc.bold('npx codex-mem start')}`,
        ``,
        `${pc.bold('First success:')} keep ${pc.underline(`http://localhost:${workerPort}`)} open in a browser, then open Codex Code in any project. Observations stream in as Codex reads, edits, and runs commands.`,
        ``,
        `${pc.bold('Two paths from here:')}`,
        `  ${pc.cyan('A.')} Just start working. Memory builds passively from your first prompt. (Recommended.)`,
        `  ${pc.cyan('B.')} Front-load it: open Codex Code and run ${pc.bold('/learn-codebase')} to ingest the whole repo (~5 min, optional).`,
        ``,
        `Memory injection starts on your second session in a project.`,
        `Everything stays in ${pc.cyan('~/.codex-mem')} on this machine.`,
        ``,
        `${pc.dim('How it works: /how-it-works   ·   Disable first-session hint: CODEX_MEM_WELCOME_HINT_ENABLED=false')}`,
        `${pc.dim('Note: close all Codex Code sessions before uninstalling, or ~/.codex-mem will be recreated by active hooks.')}`,
      ];

  if (isInteractive) {
    p.note(nextSteps.join('\n'), 'Next Steps');
    if (failedIDEs.length > 0) {
      p.outro(pc.yellow('codex-mem installed with some IDE setup failures.'));
    } else {
      p.outro(pc.green('codex-mem installed successfully!'));
    }
  } else {
    console.log('\n  Next Steps');
    nextSteps.forEach(l => console.log(`  ${l}`));
    if (failedIDEs.length > 0) {
      console.log('\ncodex-mem installed with some IDE setup failures.');
      process.exitCode = 1;
    } else {
      console.log('\ncodex-mem installed successfully!');
    }
  }
}

export async function runRepairCommand(): Promise<void> {
  const version = readPluginVersion();
  const cacheDir = pluginCacheDirectory(version);

  if (isInteractive) {
    p.intro(pc.bgCyan(pc.black(' codex-mem repair ')));
  } else {
    console.log('codex-mem repair');
  }
  log.info(`Version: ${pc.cyan(version)}`);

  await runTasks([
    {
      title: 'Setting up runtime',
      task: async (message) => {
        message('Checking Bun…');
        const { version: bunVersion } = await ensureBun();
        message('Checking uv…');
        const { version: uvVersion } = await ensureUv();
        // Repair must regenerate the cache if it was wiped (e.g. user ran
        // `rm -rf ~/.codex/plugins/cache`). Without this, bun install would
        // fail immediately with no package.json to install against.
        if (!existsSync(join(cacheDir, 'package.json'))) {
          message('Cache missing — repopulating from npm package…');
          copyPluginToCache(version);
        }
        message('Reinstalling plugin dependencies…');
        const { bunPath } = await ensureBun();
        await installPluginDependencies(cacheDir, bunPath);
        writeInstallMarker(cacheDir, version, bunVersion, uvVersion);
        return `Runtime ready (Bun ${bunVersion}, uv ${uvVersion}) ${pc.green('OK')}`;
      },
    },
  ]);

  if (isInteractive) {
    p.outro(pc.green('codex-mem repair complete.'));
  } else {
    console.log('codex-mem repair complete.');
  }
}
