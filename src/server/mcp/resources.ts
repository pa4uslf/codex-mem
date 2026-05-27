// SPDX-License-Identifier: Apache-2.0

export const serverMemoryResources = [
  {
    uri: 'codex-mem://server/projects',
    name: 'Codex-Mem Server Projects',
    description: 'Authorized project list exposed by Codex-Mem Server.',
    mimeType: 'application/json',
  },
  {
    uri: 'codex-mem://server/memories/recent',
    name: 'Recent Codex-Mem Server Memories',
    description: 'Recent authorized memory items from the server core.',
    mimeType: 'application/json',
  },
] as const;
