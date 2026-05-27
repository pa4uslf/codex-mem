#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TAG="${TAG:-codex-mem:basic}"

HOST_MEM_DIR="${HOST_MEM_DIR:-$REPO_ROOT/.docker-codex-mem-data}"
mkdir -p "$HOST_MEM_DIR"
echo "[run] host .codex-mem dir: $HOST_MEM_DIR" >&2

CREDS_FILE=""
CREDS_MOUNT_ARGS=()
if [[ -z "${CODEX_API_KEY:-}" ]]; then
  CREDS_FILE="$(mktemp -t codex-mem-creds.XXXXXX.json)"
  trap 'rm -f "$CREDS_FILE"' EXIT

  creds_obtained=0
  if [[ "$(uname)" == "Darwin" ]]; then
    if security find-generic-password -s 'Codex Code-credentials' -w > "$CREDS_FILE" 2>/dev/null \
       && [[ -s "$CREDS_FILE" ]]; then
      creds_obtained=1
    fi
  fi
  if [[ "$creds_obtained" -eq 0 && -f "$HOME/.codex/.credentials.json" ]]; then
    cp "$HOME/.codex/.credentials.json" "$CREDS_FILE"
    creds_obtained=1
  fi
  if [[ "$creds_obtained" -eq 0 ]]; then
    echo "ERROR: no CODEX_API_KEY set and no Codex OAuth credentials found." >&2
    echo "       Tried: macOS Keychain ('Codex Code-credentials') and ~/.codex/.credentials.json." >&2
    echo "       Run \`codex login\` on the host first, or set CODEX_API_KEY." >&2
    exit 1
  fi
  chmod 600 "$CREDS_FILE"
  CREDS_MOUNT_ARGS=(
    -e CODEX_MEM_CREDENTIALS_FILE=/auth/.credentials.json
    -v "$CREDS_FILE:/auth/.credentials.json:ro"
  )
else
  CREDS_MOUNT_ARGS=(-e CODEX_API_KEY)
fi

TTY_ARGS=()
[[ -t 0 && -t 1 ]] && TTY_ARGS=(-it)

docker run --rm ${TTY_ARGS[@]+"${TTY_ARGS[@]}"} \
  "${CREDS_MOUNT_ARGS[@]}" \
  -v "$HOST_MEM_DIR:/home/node/.codex-mem" \
  "$TAG" \
  "$@"
