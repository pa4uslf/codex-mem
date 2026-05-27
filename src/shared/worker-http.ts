import path from "path";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";

function readTimeoutEnv(
  envName: string,
  defaultValue: number,
  bounds: { min: number; max: number }
): number {
  const envVal = process.env[envName];
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed >= bounds.min && parsed <= bounds.max) {
      return parsed;
    }
    logger.warn('SYSTEM', `Invalid ${envName}, using default`, {
      value: envVal, min: bounds.min, max: bounds.max
    });
  }
  return defaultValue;
}

export const HEALTH_CHECK_TIMEOUT_MS = readTimeoutEnv(
  'CODEX_MEM_HEALTH_TIMEOUT_MS',
  getTimeout(HOOK_TIMEOUTS.HEALTH_CHECK),
  { min: 500, max: 300000 }
);

export const API_REQUEST_TIMEOUT_MS = readTimeoutEnv(
  'CODEX_MEM_API_TIMEOUT_MS',
  getTimeout(HOOK_TIMEOUTS.API_REQUEST),
  { min: 500, max: 300000 }
);

export const HOOK_READINESS_TIMEOUT_MS = readTimeoutEnv(
  'CODEX_MEM_HOOK_READINESS_TIMEOUT_MS',
  getTimeout(HOOK_TIMEOUTS.HOOK_READINESS_WAIT),
  { min: 0, max: 300000 }
);

export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(
      () => reject(new Error(`Request timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    fetch(url, init).then(
      response => { clearTimeout(timeoutId); resolve(response); },
      err => { clearTimeout(timeoutId); reject(err); }
    );
  });
}

let cachedPort: number | null = null;
let cachedHost: string | null = null;

export function getWorkerPort(): number {
  if (cachedPort !== null) {
    return cachedPort;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CODEX_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedPort = parseInt(settings.CODEX_MEM_WORKER_PORT, 10);
  return cachedPort;
}

export function getWorkerHost(): string {
  if (cachedHost !== null) {
    return cachedHost;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CODEX_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedHost = settings.CODEX_MEM_WORKER_HOST;
  return cachedHost;
}

export function clearPortCache(): void {
  cachedPort = null;
  cachedHost = null;
}

export function buildWorkerUrl(apiPath: string): string {
  return `http://${getWorkerHost()}:${getWorkerPort()}${apiPath}`;
}

export function workerHttpRequest(
  apiPath: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {}
): Promise<Response> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? API_REQUEST_TIMEOUT_MS;

  const url = buildWorkerUrl(apiPath);
  const init: RequestInit = { method };
  if (options.headers) {
    init.headers = options.headers;
  }
  if (options.body) {
    init.body = options.body;
  }

  if (timeoutMs > 0) {
    return fetchWithTimeout(url, init, timeoutMs);
  }
  return fetch(url, init);
}
