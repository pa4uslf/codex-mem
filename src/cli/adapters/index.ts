import type { PlatformAdapter } from '../types.js';
import { codexCodeAdapter } from './codex-code.js';
import { codexAdapter } from './codex.js';
import { cursorAdapter } from './cursor.js';
import { geminiCliAdapter } from './gemini-cli.js';
import { rawAdapter } from './raw.js';
import { windsurfAdapter } from './windsurf.js';

export function getPlatformAdapter(platform: string): PlatformAdapter {
  switch (platform) {
    case 'codex-code': return codexCodeAdapter;
    case 'codex': return codexAdapter;
    case 'cursor': return cursorAdapter;
    case 'gemini':
    case 'gemini-cli': return geminiCliAdapter;
    case 'windsurf': return windsurfAdapter;
    case 'raw': return rawAdapter;
    default: return rawAdapter;
  }
}

export { codexCodeAdapter, codexAdapter, cursorAdapter, geminiCliAdapter, rawAdapter, windsurfAdapter };
