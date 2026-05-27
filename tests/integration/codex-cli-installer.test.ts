import { describe, expect, it } from 'bun:test';
import {
  setTomlFeatureEnabled,
  setTomlPluginEnabled,
} from '../../src/services/integrations/CodexCliInstaller.js';

describe('Codex CLI installer config repair', () => {
  it('adds codex-mem plugin enablement when missing', () => {
    const result = setTomlPluginEnabled('model = "gpt-5.5"\n', 'codex-mem@codex-mem-local', true);

    expect(result).toContain('[plugins."codex-mem@codex-mem-local"]');
    expect(result).toContain('enabled = true');
  });

  it('updates existing plugin enablement in place', () => {
    const input = [
      '[plugins."codex-mem@thedotmack"]',
      'enabled = true',
      '',
      '[marketplaces.codex-mem-local]',
      'source_type = "git"',
      '',
    ].join('\n');

    const result = setTomlPluginEnabled(input, 'codex-mem@thedotmack', false);

    expect(result).toContain('[plugins."codex-mem@thedotmack"]\nenabled = false');
    expect(result).toContain('[marketplaces.codex-mem-local]');
  });

  it('inserts enabled into an existing plugin section without touching the next section', () => {
    const input = [
      '[plugins."codex-mem@codex-mem-local"]',
      '',
      '[hooks.state]',
      '',
    ].join('\n');

    const result = setTomlPluginEnabled(input, 'codex-mem@codex-mem-local', true);

    expect(result).toContain('[plugins."codex-mem@codex-mem-local"]\nenabled = true\n');
    expect(result).toContain('[hooks.state]');
  });

  it('enables the current Codex hooks feature flag', () => {
    const input = [
      '[features]',
      'shell_snapshot = true',
      '',
      '[plugins."codex-mem@codex-mem-local"]',
      'enabled = true',
      '',
    ].join('\n');

    const result = setTomlFeatureEnabled(input, 'hooks', true);

    expect(result).toContain('[features]\nhooks = true\nshell_snapshot = true');
    expect(result).toContain('[plugins."codex-mem@codex-mem-local"]');
    expect(result).not.toContain('codex_hooks');
  });
});
