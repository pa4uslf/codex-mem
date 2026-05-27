import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { disableCodexAutoMemory } from '../src/npx-cli/commands/install.js';

/**
 * Tests for auto-memory disable behavior in the install command.
 *
 * Closes codexs/codex-code#23544 from codex-mem's side: any install that
 * targets codex-code must set CODEX_CODE_DISABLE_AUTO_MEMORY=1 in
 * ~/.codex/settings.json `env` block. The built-in MEMORY.md system creates
 * shadow state outside the user's control and competes with codex-mem's
 * hook-based memory for context-window tokens.
 *
 * Source-inspection style mirrors install-non-tty.test.ts — disableCodexAutoMemory
 * is a private module-level helper that can't be imported directly.
 */

const installSourcePath = join(
  __dirname,
  '..',
  'src',
  'npx-cli',
  'commands',
  'install.ts',
);
const installSource = readFileSync(installSourcePath, 'utf-8');

describe('Install: disable Codex Code auto-memory', () => {
  describe('disableCodexAutoMemory helper', () => {
    it('defines the helper function', () => {
      expect(installSource).toContain('function disableCodexAutoMemory()');
    });

    it('writes CODEX_CODE_DISABLE_AUTO_MEMORY=1 to settings.json env block', () => {
      // The string '1' (not boolean true) is required — env vars are always strings.
      expect(installSource).toMatch(/CODEX_CODE_DISABLE_AUTO_MEMORY:\s*['"]1['"]/);
    });

    it('reads existing settings via readJsonSafe (preserves other keys)', () => {
      // Must round-trip through readJsonSafe + writeJsonFileAtomic, never overwrite blindly.
      const helperBody = installSource.match(
        /function disableCodexAutoMemory\(\)[\s\S]*?\n\}/,
      )?.[0];
      expect(helperBody).toBeDefined();
      expect(helperBody).toContain('readJsonSafe');
      expect(helperBody).toContain('writeJsonFileAtomic(codexSettingsPath()');
    });

    it('merges with existing env vars instead of replacing the env block', () => {
      // Spread of existing env into new env is what preserves user-set vars
      // like CODEX_AUTH_TOKEN, AWS_REGION, etc.
      const helperBody = installSource.match(
        /function disableCodexAutoMemory\(\)[\s\S]*?\n\}/,
      )?.[0];
      expect(helperBody).toMatch(/\.\.\.env/);
    });

    it('is idempotent — returns false (no write) when already set to "1"', () => {
      const helperBody = installSource.match(
        /function disableCodexAutoMemory\(\)[\s\S]*?\n\}/,
      )?.[0];
      expect(helperBody).toMatch(/CODEX_CODE_DISABLE_AUTO_MEMORY === ['"]1['"]/);
      expect(helperBody).toMatch(/return false/);
    });

    it('returns true after a successful write', () => {
      const helperBody = installSource.match(
        /function disableCodexAutoMemory\(\)[\s\S]*?\n\}/,
      )?.[0];
      expect(helperBody).toMatch(/return true/);
    });
  });

  describe('runInstallCommand integration', () => {
    it('calls disableCodexAutoMemory after setupIDEs', () => {
      // setupIDEs returns first; we need its result before deciding what to do,
      // and the disable step shouldn't run if codex-code wasn't installed.
      // Use lastIndexOf for the call so we match the call site, not the helper definition.
      const setupCallIdx = installSource.indexOf('await setupIDEs(selectedIDEs)');
      const disableCallIdx = installSource.lastIndexOf('disableCodexAutoMemory()');
      expect(setupCallIdx).toBeGreaterThan(-1);
      expect(disableCallIdx).toBeGreaterThan(-1);
      expect(disableCallIdx).toBeGreaterThan(setupCallIdx);
    });

    it("only runs the disable step when codex-code is in selectedIDEs", () => {
      // Cursor/Codex/Windsurf installs shouldn't touch ~/.codex/settings.json
      // for an env var that doesn't apply to them.
      expect(installSource).toMatch(
        /selectedIDEs\.includes\(['"]codex-code['"]\)[\s\S]{0,200}disableCodexAutoMemory\(\)/,
      );
    });

    it('catches errors from disableCodexAutoMemory and continues', () => {
      // Settings.json is the user's file — a write failure (permissions, disk
      // full, etc.) must surface as a warning, not abort the install.
      const integrationBlock = installSource.match(
        /selectedIDEs\.includes\(['"]codex-code['"]\)[\s\S]{0,800}/,
      )?.[0];
      expect(integrationBlock).toBeDefined();
      expect(integrationBlock).toContain('try {');
      expect(integrationBlock).toMatch(/const wrote = disableCodexAutoMemory\(\)/);
      expect(integrationBlock).toContain('catch');
      expect(integrationBlock).toMatch(/log\.warn/);
    });

    it('tracks a tri-state autoMemoryStatus (disabled / already-disabled / failed)', () => {
      // A boolean would conflate the error path with "already set", so a write
      // failure mid-install would silently render "already disabled" in the
      // summary while the warning above said the opposite. Tri-state keeps the
      // log line and the summary line truthful and consistent.
      expect(installSource).toMatch(
        /let autoMemoryStatus:\s*['"]disabled['"]\s*\|\s*['"]already-disabled['"]\s*\|\s*['"]failed['"]\s*\|\s*null/,
      );
      const integrationBlock = installSource.match(
        /selectedIDEs\.includes\(['"]codex-code['"]\)[\s\S]{0,800}/,
      )?.[0];
      expect(integrationBlock).toMatch(/autoMemoryStatus = wrote \? ['"]disabled['"] : ['"]already-disabled['"]/);
      expect(integrationBlock).toMatch(/autoMemoryStatus = ['"]failed['"]/);
    });

    it('surfaces all three states in the install summary distinctly', () => {
      // The error case must NOT render as "already disabled" — that would
      // contradict the warn line above it and falsely imply the env var is set.
      expect(installSource).toMatch(
        /autoMemoryStatus === ['"]disabled['"][\s\S]{0,200}CODEX_CODE_DISABLE_AUTO_MEMORY=1/,
      );
      expect(installSource).toMatch(
        /autoMemoryStatus === ['"]already-disabled['"][\s\S]{0,200}already disabled/,
      );
      expect(installSource).toMatch(
        /autoMemoryStatus === ['"]failed['"][\s\S]{0,200}write failed/,
      );
    });
  });

  // Behavioral test that exercises real file I/O against a temp Codex config dir.
  // Complements the source-inspection tests above: catches runtime bugs (overwriting
  // env block, dropping existing keys, non-string values, etc.) that string matching
  // can't see. Uses CODEX_CONFIG_DIR override so we don't touch the user's settings.
  describe('disableCodexAutoMemory runtime behavior', () => {
    let tempDir: string;
    let originalConfigDir: string | undefined;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'codex-mem-disable-auto-memory-'));
      originalConfigDir = process.env.CODEX_CONFIG_DIR;
      process.env.CODEX_CONFIG_DIR = tempDir;
    });

    afterEach(() => {
      if (originalConfigDir === undefined) {
        delete process.env.CODEX_CONFIG_DIR;
      } else {
        process.env.CODEX_CONFIG_DIR = originalConfigDir;
      }
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('writes the env var when settings.json is missing', () => {
      const wrote = disableCodexAutoMemory();
      expect(wrote).toBe(true);

      const settings = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf-8'));
      expect(settings.env.CODEX_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    });

    it('preserves existing env vars and other top-level keys', () => {
      writeFileSync(
        join(tempDir, 'settings.json'),
        JSON.stringify({
          theme: 'dark',
          env: {
            CODEX_AUTH_TOKEN: 'sk-test',
            AWS_REGION: 'us-east-1',
          },
          permissions: { defaultMode: 'auto' },
        }, null, 2),
      );

      const wrote = disableCodexAutoMemory();
      expect(wrote).toBe(true);

      const settings = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf-8'));
      expect(settings.theme).toBe('dark');
      expect(settings.permissions).toEqual({ defaultMode: 'auto' });
      expect(settings.env.CODEX_AUTH_TOKEN).toBe('sk-test');
      expect(settings.env.AWS_REGION).toBe('us-east-1');
      expect(settings.env.CODEX_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    });

    it('is idempotent — second call returns false and leaves the file untouched', () => {
      const firstWrite = disableCodexAutoMemory();
      expect(firstWrite).toBe(true);

      const settingsPath = join(tempDir, 'settings.json');
      const contentBefore = readFileSync(settingsPath, 'utf-8');

      const secondWrite = disableCodexAutoMemory();
      expect(secondWrite).toBe(false);

      const contentAfter = readFileSync(settingsPath, 'utf-8');
      expect(contentAfter).toBe(contentBefore);
    });

    it('writes the literal string "1", not boolean true', () => {
      // Env vars are always strings — boolean true would be coerced unpredictably
      // by Codex Code's env loader.
      disableCodexAutoMemory();
      const raw = readFileSync(join(tempDir, 'settings.json'), 'utf-8');
      expect(raw).toMatch(/"CODEX_CODE_DISABLE_AUTO_MEMORY":\s*"1"/);
      expect(raw).not.toMatch(/"CODEX_CODE_DISABLE_AUTO_MEMORY":\s*true/);
    });

    it('replaces a non-object env value with a fresh env block', () => {
      // Defensive: if settings.env is malformed (string, null, array), the helper
      // still has to land on a valid object containing the env var.
      writeFileSync(
        join(tempDir, 'settings.json'),
        JSON.stringify({ env: 'not-an-object', theme: 'dark' }),
      );

      const wrote = disableCodexAutoMemory();
      expect(wrote).toBe(true);

      const settings = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf-8'));
      expect(settings.theme).toBe('dark');
      expect(typeof settings.env).toBe('object');
      expect(settings.env.CODEX_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    });
  });
});
