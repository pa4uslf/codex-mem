# codex-mem Docker harness

A minimal container for exercising codex-mem end-to-end without polluting your
host. Not a dev environment — just enough to boot `codex` with the locally-built
plugin and capture observations into a throwaway SQLite DB you can inspect
afterwards.

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Image definition (node:20 + Bun + uv + Codex Code CLI + local `plugin/`) |
| `build.sh` | Runs `npm run build` then `docker build`. Tag defaults to `codex-mem:basic`. |
| `entrypoint.sh` | Runs inside the container. Seeds OAuth creds into `$HOME/.codex/` if mounted, then `exec "$@"`. |
| `run.sh` | Host-side launcher. Extracts creds (Keychain → file → env), mounts a persistent data dir, drops you into an interactive shell. |

## Quick start

```bash
# From the repo root:
docker/codex-mem/build.sh
docker/codex-mem/run.sh
```

`run.sh` drops you into `bash` inside the container with `codex` on `PATH` and
the plugin pre-staged at `/opt/codex-mem`. Launch it with:

```bash
codex --plugin-dir /opt/codex-mem
```

On exit, the SQLite DB survives at `./.docker-codex-mem-data/codex-mem.db` on
the host — inspect with:

```bash
sqlite3 .docker-codex-mem-data/codex-mem.db 'select count(*) from observations'
```

## What's in the image

Mirrors the layout of [codexs/codex-code's devcontainer](https://github.com/codexs/codex-code/blob/main/.devcontainer/Dockerfile):
`FROM node:20`, non-root `node` user, global `npm install -g @codex-ai/codex-code`.
Skips the firewall/zsh/fzf/delta/git-hist tooling since this image is about
running codex-mem, not editing code.

On top of that:

- **Bun** (`/usr/local/bun`) — codex-mem's worker service runtime
- **uv** (`/usr/local/bin/uv`) — provides Python for Chroma per `CODEX.md`
- **`plugin/`** copied to `/opt/codex-mem` — the locally-built plugin tree
- **`/home/node/.codex`** and **`/home/node/.codex-mem`** — pre-created mount points

Layer ordering is deliberate: plugin files are copied **after** the `npm install`
layer so iterating on the plugin doesn't bust the CLI install cache.

## Pinning versions

Everything that matters is a `--build-arg` — pin for reproducibility, omit for
latest:

```bash
docker build \
  -f docker/codex-mem/Dockerfile \
  --build-arg BUN_VERSION=1.3.12 \
  --build-arg UV_VERSION=0.11.7 \
  --build-arg CODEX_CODE_VERSION=1.2.3 \
  -t codex-mem:basic .
```

| Arg | Default | Notes |
|-----|---------|-------|
| `BUN_VERSION` | `1.3.12` | Installed via the official `bun.sh/install` script, tag `bun-v${BUN_VERSION}`. |
| `UV_VERSION` | `0.11.7` | Installed via the versioned `astral.sh/uv/${UV_VERSION}/install.sh`. |
| `CODEX_CODE_VERSION` | `latest` | npm tag or exact version. Pin in CI, let it float locally. |

## Authentication

`run.sh` picks the first auth source that works, in this order:

1. **`CODEX_API_KEY`** env var — mounted straight into the container.
2. **macOS Keychain** — `security find-generic-password -s 'Codex Code-credentials'`.
3. **`~/.codex/.credentials.json`** — legacy on-disk form, still present on some
   older CLI installs and migrated machines.

If a credentials file is used, it's written to a `mktemp` file with `chmod 600`,
mounted read-only at `/auth/.credentials.json`, and the container's entrypoint
copies it to `$HOME/.codex/.credentials.json` before exec. An `EXIT` trap
deletes the temp file when `run.sh` returns — `docker run` is deliberately **not**
`exec`'d so the trap gets a chance to fire.

If no auth source is found, `run.sh` exits with an error pointing you at
`codex login` or `CODEX_API_KEY`.

## Manual invocation (without `run.sh`)

```bash
docker run --rm -it \
  -v $(mktemp -d):/home/node/.codex-mem \
  -e CODEX_MEM_CREDENTIALS_FILE=/auth/.credentials.json \
  -v /path/to/creds.json:/auth/.credentials.json:ro \
  codex-mem:basic
```

Or with API key auth:

```bash
docker run --rm -it \
  -v $(mktemp -d):/home/node/.codex-mem \
  -e CODEX_API_KEY \
  codex-mem:basic
```

## Environment variables

| Var | Where | Purpose |
|-----|-------|---------|
| `TAG` | `build.sh`, `run.sh` | Override image tag (default `codex-mem:basic`). |
| `HOST_MEM_DIR` | `run.sh` | Override host path for the persistent `.codex-mem` volume (default `$REPO_ROOT/.docker-codex-mem-data`). |
| `CODEX_API_KEY` | `run.sh`, entrypoint | API-key auth. Skips the OAuth creds extraction. |
| `CODEX_MEM_CREDENTIALS_FILE` | entrypoint | Path (inside the container) to a mounted OAuth creds JSON. Copied to `$HOME/.codex/.credentials.json` at startup. |

## Passing args through

Anything after `run.sh` is forwarded to the container as the command:

```bash
docker/codex-mem/run.sh codex --plugin-dir /opt/codex-mem --print "what did we learn yesterday?"
```

## Cleanup

```bash
rm -rf .docker-codex-mem-data   # wipes the persistent DB + Chroma store
docker rmi codex-mem:basic       # removes the image
```
