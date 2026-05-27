# Codex CLI execution

codex-mem uses the Codex CLI for background memory extraction. The worker starts non-interactive `codex exec` subprocesses and reads the final assistant message from `--output-last-message`.

## Installation

Install and authenticate the Codex CLI before using the `codex` provider:

```bash
npm install -g @openai/codex
codex login
```

## Non-interactive prompt

```bash
codex exec \
  --json \
  --sandbox read-only \
  --skip-git-repo-check \
  --output-last-message /tmp/codex-mem-last-message.txt \
  "Summarize this session into reusable observations."
```

codex-mem passes the configured `CODEX_MEM_MODEL` value through `--model`. The default is `gpt-5`.

## Gateway and API key mode

The worker builds an isolated subprocess environment. Credentials should be stored in `~/.codex-mem/.env`, not inherited from a project shell:

```bash
CODEX_API_KEY=...
CODEX_BASE_URL=https://your-gateway.example.com/v1
CODEX_AUTH_TOKEN=...
```

`CODEX_BASE_URL` and `CODEX_AUTH_TOKEN` are only needed for gateway deployments.
