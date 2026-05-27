
import { CorpusStore } from './CorpusStore.js';
import { CorpusRenderer } from './CorpusRenderer.js';
import type { CorpusFile, QueryResult } from './types.js';
import { logger } from '../../../utils/logger.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import { queryGeminiText } from '../GeminiProvider.js';
import { queryOpenRouterText } from '../OpenRouterProvider.js';

export class KnowledgeAgent {
  private renderer: CorpusRenderer;

  constructor(
    private corpusStore: CorpusStore
  ) {
    this.renderer = new CorpusRenderer();
  }

  async prime(corpus: CorpusFile): Promise<string> {
    const sessionId = `knowledge-${corpus.name}-${Date.now()}`;
    corpus.session_id = sessionId;
    this.corpusStore.write(corpus);
    logger.info('WORKER', `Knowledge corpus "${corpus.name}" primed for stateless provider queries`);
    return sessionId;
  }

  async query(corpus: CorpusFile, question: string): Promise<QueryResult> {
    if (!corpus.session_id) {
      throw new Error(`Corpus "${corpus.name}" has no session — call prime first`);
    }

    try {
      const result = await this.executeQuery(corpus, question);
      if (result.session_id !== corpus.session_id) {
        corpus.session_id = result.session_id;
        this.corpusStore.write(corpus);
      }
      return result;
    } catch (error) {
      if (!this.isSessionResumeError(error)) {
        if (error instanceof Error) {
          logger.error('WORKER', `Query failed for corpus "${corpus.name}"`, {}, error);
        } else {
          logger.error('WORKER', `Query failed for corpus "${corpus.name}" (non-Error thrown)`, { thrownValue: String(error) });
        }
        throw error;
      }
      logger.info('WORKER', `Session expired for corpus "${corpus.name}", auto-repriming...`);
      await this.prime(corpus);
      const refreshedCorpus = this.corpusStore.read(corpus.name);
      if (!refreshedCorpus || !refreshedCorpus.session_id) {
        throw new Error(`Auto-reprime failed for corpus "${corpus.name}"`);
      }
      const result = await this.executeQuery(refreshedCorpus, question);
      if (result.session_id !== refreshedCorpus.session_id) {
        refreshedCorpus.session_id = result.session_id;
        this.corpusStore.write(refreshedCorpus);
      }
      return result;
    }
  }

  async reprime(corpus: CorpusFile): Promise<string> {
    corpus.session_id = null;  
    return this.prime(corpus);
  }

  private isSessionResumeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /session|resume|expired|invalid.*session|not found/i.test(message);
  }

  private async executeQuery(corpus: CorpusFile, question: string): Promise<QueryResult> {
    const prompt = [
      corpus.system_prompt,
      '',
      'Knowledge base:',
      '',
      this.renderer.renderCorpus(corpus),
      '',
      'Question:',
      question,
    ].join('\n');
    return { answer: await this.queryConfiguredProvider(prompt), session_id: corpus.session_id! };
  }

  private async queryConfiguredProvider(prompt: string): Promise<string> {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (settings.CODEX_MEM_PROVIDER === 'gemini') {
      return queryGeminiText(prompt, {
        apiKey: settings.CODEX_MEM_GEMINI_API_KEY,
        model: settings.CODEX_MEM_GEMINI_MODEL as any,
      });
    }
    if (settings.CODEX_MEM_PROVIDER === 'openrouter') {
      return queryOpenRouterText(prompt, {
        apiKey: settings.CODEX_MEM_OPENROUTER_API_KEY,
        model: settings.CODEX_MEM_OPENROUTER_MODEL,
        siteUrl: settings.CODEX_MEM_OPENROUTER_SITE_URL,
        appName: settings.CODEX_MEM_OPENROUTER_APP_NAME,
      });
    }
    throw new Error('KnowledgeAgent requires CODEX_MEM_PROVIDER=gemini or CODEX_MEM_PROVIDER=openrouter.');
  }

}
