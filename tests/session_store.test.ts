import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('should correctly count user prompts', () => {
    const codexId = 'codex-session-1';
    store.createSDKSession(codexId, 'test-project', 'initial prompt');
    
    expect(store.getPromptNumberFromUserPrompts(codexId)).toBe(0);

    store.saveUserPrompt(codexId, 1, 'First prompt');
    expect(store.getPromptNumberFromUserPrompts(codexId)).toBe(1);

    store.saveUserPrompt(codexId, 2, 'Second prompt');
    expect(store.getPromptNumberFromUserPrompts(codexId)).toBe(2);

    store.createSDKSession('codex-session-2', 'test-project', 'initial prompt');
    store.saveUserPrompt('codex-session-2', 1, 'Other prompt');
    expect(store.getPromptNumberFromUserPrompts(codexId)).toBe(2);
  });

  it('should store observation with timestamp override', () => {
    const codexId = 'codex-sess-obs';
    const memoryId = 'memory-sess-obs';
    const sdkId = store.createSDKSession(codexId, 'test-project', 'initial prompt');

    store.updateMemorySessionId(sdkId, memoryId);

    const obs = {
      type: 'discovery',
      title: 'Test Obs',
      subtitle: null,
      facts: [],
      narrative: 'Testing',
      concepts: [],
      files_read: [],
      files_modified: []
    };

    const pastTimestamp = 1600000000000; 

    const result = store.storeObservation(
      memoryId, // Use memorySessionId for FK reference
      'test-project',
      obs,
      1,
      0,
      pastTimestamp
    );

    expect(result.createdAtEpoch).toBe(pastTimestamp);

    const stored = store.getObservationById(result.id);
    expect(stored).not.toBeNull();
    expect(stored?.created_at_epoch).toBe(pastTimestamp);

    expect(new Date(stored!.created_at).getTime()).toBe(pastTimestamp);
  });

  it('should store summary with timestamp override', () => {
    const codexId = 'codex-sess-sum';
    const memoryId = 'memory-sess-sum';
    const sdkId = store.createSDKSession(codexId, 'test-project', 'initial prompt');

    store.updateMemorySessionId(sdkId, memoryId);

    const summary = {
      request: 'Do something',
      investigated: 'Stuff',
      learned: 'Things',
      completed: 'Done',
      next_steps: 'More',
      notes: null
    };

    const pastTimestamp = 1650000000000;

    const result = store.storeSummary(
      memoryId, // Use memorySessionId for FK reference
      'test-project',
      summary,
      1,
      0,
      pastTimestamp
    );

    expect(result.createdAtEpoch).toBe(pastTimestamp);

    const stored = store.getSummaryForSession(memoryId);
    expect(stored).not.toBeNull();
    expect(stored?.created_at_epoch).toBe(pastTimestamp);
  });
});
