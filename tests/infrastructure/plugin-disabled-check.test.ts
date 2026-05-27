import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isPluginDisabledInCodexSettings } from '../../src/shared/plugin-state.js';

let tempDir: string;
let originalCodexConfigDir: string | undefined;

beforeEach(() => {
  tempDir = join(tmpdir(), `plugin-disabled-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  originalCodexConfigDir = process.env.CODEX_CONFIG_DIR;
  process.env.CODEX_CONFIG_DIR = tempDir;
});

afterEach(() => {
  if (originalCodexConfigDir !== undefined) {
    process.env.CODEX_CONFIG_DIR = originalCodexConfigDir;
  } else {
    delete process.env.CODEX_CONFIG_DIR;
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('isPluginDisabledInCodexSettings (#781)', () => {
  it('should return false when settings.json does not exist', () => {
    expect(isPluginDisabledInCodexSettings()).toBe(false);
  });

  it('should return false when plugin is explicitly enabled', () => {
    const settings = {
      enabledPlugins: {
        'codex-mem@thedotmack': true
      }
    };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings));
    expect(isPluginDisabledInCodexSettings()).toBe(false);
  });

  it('should return true when plugin is explicitly disabled', () => {
    const settings = {
      enabledPlugins: {
        'codex-mem@thedotmack': false
      }
    };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings));
    expect(isPluginDisabledInCodexSettings()).toBe(true);
  });

  it('should return false when enabledPlugins key is missing', () => {
    const settings = {
      permissions: { allow: [] }
    };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings));
    expect(isPluginDisabledInCodexSettings()).toBe(false);
  });

  it('should return false when plugin key is absent from enabledPlugins', () => {
    const settings = {
      enabledPlugins: {
        'other-plugin@marketplace': true
      }
    };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings));
    expect(isPluginDisabledInCodexSettings()).toBe(false);
  });

  it('should return false when settings.json contains invalid JSON', () => {
    writeFileSync(join(tempDir, 'settings.json'), '{ invalid json }}}');
    expect(isPluginDisabledInCodexSettings()).toBe(false);
  });

  it('should return false when settings.json is empty', () => {
    writeFileSync(join(tempDir, 'settings.json'), '');
    expect(isPluginDisabledInCodexSettings()).toBe(false);
  });
});
