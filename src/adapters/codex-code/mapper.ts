// SPDX-License-Identifier: Apache-2.0

import type { CreateAgentEvent } from '../../core/schemas/agent-event.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

export interface CodexCodeBasePayload {
  contentSessionId: string;
  memorySessionId?: string | null;
  platformSource?: string | null;
  cwd?: string;
  agentId?: string;
  agentType?: string;
  [key: string]: unknown;
}

export interface CodexCodeObservationPayload extends CodexCodeBasePayload {
  tool_name: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  toolUseId?: string;
}

export function mapCodexCodeSessionInitToAgentEvent(
  projectId: string,
  payload: CodexCodeBasePayload,
  occurredAtEpoch = Date.now(),
): CreateAgentEvent {
  return mapCodexCodePayload(projectId, payload, 'session.init', occurredAtEpoch);
}

export function mapCodexCodeObservationToAgentEvent(
  projectId: string,
  payload: CodexCodeObservationPayload,
  occurredAtEpoch = Date.now(),
): CreateAgentEvent {
  return mapCodexCodePayload(projectId, payload, 'observation.created', occurredAtEpoch);
}

export function mapCodexCodeSummaryToAgentEvent(
  projectId: string,
  payload: CodexCodeBasePayload,
  occurredAtEpoch = Date.now(),
): CreateAgentEvent {
  return mapCodexCodePayload(projectId, payload, 'session.summary', occurredAtEpoch);
}

function mapCodexCodePayload(
  projectId: string,
  payload: CodexCodeBasePayload,
  eventType: string,
  occurredAtEpoch: number,
): CreateAgentEvent {
  const platformSource = normalizePlatformSource(payload.platformSource);
  return {
    projectId,
    sourceType: 'hook',
    eventType,
    payload: {
      ...payload,
      platformSource,
      toolUseId: payload.toolUseId ?? payload.tool_use_id ?? null,
    },
    contentSessionId: payload.contentSessionId,
    memorySessionId: payload.memorySessionId ?? null,
    occurredAtEpoch,
  };
}
