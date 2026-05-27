import { useState, useEffect } from 'react';
import { Settings } from '../types';
import { DEFAULT_SETTINGS } from '../constants/settings';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';
import { authFetch } from '../utils/api';

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');

  useEffect(() => {
    authFetch(API_ENDPOINTS.SETTINGS)
      .then(async res => {
        if (!res.ok) {
          throw new Error(`Failed to load settings (${res.status})`);
        }
        return res.json();
      })
      .then(data => {
        setSettings({
          CODEX_MEM_MODEL: data.CODEX_MEM_MODEL ?? DEFAULT_SETTINGS.CODEX_MEM_MODEL,
          CODEX_MEM_CONTEXT_OBSERVATIONS: data.CODEX_MEM_CONTEXT_OBSERVATIONS ?? DEFAULT_SETTINGS.CODEX_MEM_CONTEXT_OBSERVATIONS,
          CODEX_MEM_WORKER_PORT: data.CODEX_MEM_WORKER_PORT ?? DEFAULT_SETTINGS.CODEX_MEM_WORKER_PORT,
          CODEX_MEM_WORKER_HOST: data.CODEX_MEM_WORKER_HOST ?? DEFAULT_SETTINGS.CODEX_MEM_WORKER_HOST,

          CODEX_MEM_PROVIDER: data.CODEX_MEM_PROVIDER ?? DEFAULT_SETTINGS.CODEX_MEM_PROVIDER,
          CODEX_MEM_GEMINI_API_KEY: data.CODEX_MEM_GEMINI_API_KEY ?? DEFAULT_SETTINGS.CODEX_MEM_GEMINI_API_KEY,
          CODEX_MEM_GEMINI_MODEL: data.CODEX_MEM_GEMINI_MODEL ?? DEFAULT_SETTINGS.CODEX_MEM_GEMINI_MODEL,
          CODEX_MEM_GEMINI_RATE_LIMITING_ENABLED: data.CODEX_MEM_GEMINI_RATE_LIMITING_ENABLED ?? DEFAULT_SETTINGS.CODEX_MEM_GEMINI_RATE_LIMITING_ENABLED,

          CODEX_MEM_OPENROUTER_API_KEY: data.CODEX_MEM_OPENROUTER_API_KEY ?? DEFAULT_SETTINGS.CODEX_MEM_OPENROUTER_API_KEY,
          CODEX_MEM_OPENROUTER_MODEL: data.CODEX_MEM_OPENROUTER_MODEL ?? DEFAULT_SETTINGS.CODEX_MEM_OPENROUTER_MODEL,
          CODEX_MEM_OPENROUTER_SITE_URL: data.CODEX_MEM_OPENROUTER_SITE_URL ?? DEFAULT_SETTINGS.CODEX_MEM_OPENROUTER_SITE_URL,
          CODEX_MEM_OPENROUTER_APP_NAME: data.CODEX_MEM_OPENROUTER_APP_NAME ?? DEFAULT_SETTINGS.CODEX_MEM_OPENROUTER_APP_NAME,

          CODEX_MEM_CONTEXT_SHOW_READ_TOKENS: data.CODEX_MEM_CONTEXT_SHOW_READ_TOKENS ?? DEFAULT_SETTINGS.CODEX_MEM_CONTEXT_SHOW_READ_TOKENS,
          CODEX_MEM_CONTEXT_SHOW_WORK_TOKENS: data.CODEX_MEM_CONTEXT_SHOW_WORK_TOKENS ?? DEFAULT_SETTINGS.CODEX_MEM_CONTEXT_SHOW_WORK_TOKENS,
          CODEX_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: data.CODEX_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT ?? DEFAULT_SETTINGS.CODEX_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT,
          CODEX_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: data.CODEX_MEM_CONTEXT_SHOW_SAVINGS_PERCENT ?? DEFAULT_SETTINGS.CODEX_MEM_CONTEXT_SHOW_SAVINGS_PERCENT,

          CODEX_MEM_CONTEXT_FULL_COUNT: data.CODEX_MEM_CONTEXT_FULL_COUNT ?? DEFAULT_SETTINGS.CODEX_MEM_CONTEXT_FULL_COUNT,
          CODEX_MEM_CONTEXT_FULL_FIELD: data.CODEX_MEM_CONTEXT_FULL_FIELD ?? DEFAULT_SETTINGS.CODEX_MEM_CONTEXT_FULL_FIELD,
          CODEX_MEM_CONTEXT_SESSION_COUNT: data.CODEX_MEM_CONTEXT_SESSION_COUNT ?? DEFAULT_SETTINGS.CODEX_MEM_CONTEXT_SESSION_COUNT,

          CODEX_MEM_CONTEXT_SHOW_LAST_SUMMARY: data.CODEX_MEM_CONTEXT_SHOW_LAST_SUMMARY ?? DEFAULT_SETTINGS.CODEX_MEM_CONTEXT_SHOW_LAST_SUMMARY,
          CODEX_MEM_CONTEXT_SHOW_LAST_MESSAGE: data.CODEX_MEM_CONTEXT_SHOW_LAST_MESSAGE ?? DEFAULT_SETTINGS.CODEX_MEM_CONTEXT_SHOW_LAST_MESSAGE,
        });
      })
      .catch(error => {
        console.error('Failed to load settings:', error);
      });
  }, []);

  const saveSettings = async (newSettings: Settings) => {
    setIsSaving(true);
    setSaveStatus('Saving...');

    try {
      const response = await authFetch(API_ENDPOINTS.SETTINGS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings)
      });

      if (!response.ok) {
        setSaveStatus(`✗ Error: ${response.status === 401 ? 'Unauthorized' : response.statusText}`);
        setIsSaving(false);
        return;
      }

      const result = await response.json();

      if (result.success) {
        setSettings(newSettings);
        setSaveStatus('✓ Saved');
        setTimeout(() => setSaveStatus(''), TIMING.SAVE_STATUS_DISPLAY_DURATION_MS);
      } else {
        setSaveStatus(`✗ Error: ${result.error}`);
      }
    } catch (error) {
      setSaveStatus(`✗ Error: ${error instanceof Error ? error.message : 'Network error'}`);
    }

    setIsSaving(false);
  };

  return { settings, saveSettings, isSaving, saveStatus };
}
