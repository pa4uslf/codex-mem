
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PLUGIN_SETTINGS_KEY = 'codex-mem@thedotmack';

export function isPluginDisabledInCodexSettings(): boolean {
  try {
    const codexConfigDir = process.env.CODEX_CONFIG_DIR || join(homedir(), '.codex');
    const settingsPath = join(codexConfigDir, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const raw = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(raw);
    return settings?.enabledPlugins?.[PLUGIN_SETTINGS_KEY] === false;
  } catch (error: unknown) {
    console.error('[plugin-state] Failed to read Codex settings:', error instanceof Error ? error.message : String(error));
    return false;
  }
}
