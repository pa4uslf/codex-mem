#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

function resolveRoot() {
  if (process.env.CODEX_PLUGIN_ROOT) {
    const root = process.env.CODEX_PLUGIN_ROOT;
    if (existsSync(join(root, 'package.json'))) return root;
  }
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const candidate = dirname(scriptDir);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  } catch {}
  return null;
}

const ROOT = resolveRoot();
if (!ROOT) process.exit(0);

function emitUpgradeHint(message) {
  if (process.env.CODEX_MEM_CODEX_HOOK === '1') {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: message,
      },
    }));
  } else {
    console.error(message);
  }
}

const LEGACY_VERSION_MARKER_RE =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readInstallMarkerVersion(markerPath) {
  const content = readFileSync(markerPath, 'utf-8');
  try {
    const marker = JSON.parse(content);
    return marker && typeof marker === 'object' && typeof marker.version === 'string'
      ? marker.version
      : null;
  } catch {
    const legacyVersion = content.trim();
    return LEGACY_VERSION_MARKER_RE.test(legacyVersion)
      ? legacyVersion.replace(/^v/i, '')
      : null;
  }
}

try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const markerPath = join(ROOT, '.install-version');
  if (!existsSync(markerPath)) {
    emitUpgradeHint('codex-mem: runtime not yet set up - run: npx codex-mem@latest install');
    process.exit(0);
  }
  const markerVersion = readInstallMarkerVersion(markerPath);
  if (!markerVersion) {
    emitUpgradeHint('codex-mem: install marker unreadable - run: npx codex-mem@latest install');
  } else if (markerVersion !== pkg.version) {
    emitUpgradeHint(`codex-mem: upgraded to v${pkg.version} - run: npx codex-mem@latest install`);
  }
} catch {
  emitUpgradeHint('codex-mem: install marker unreadable - run: npx codex-mem@latest install');
}
process.exit(0);
