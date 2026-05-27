#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "Usage: $0 INSTANCE_ID REPO_SLUG BASE_COMMIT PROBLEM_STATEMENT_FILE OUT_PREDICTIONS_PATH" >&2
  exit 2
fi

INSTANCE_ID="$1"
REPO_SLUG="$2"
BASE_COMMIT="$3"
PROBLEM_STATEMENT_FILE="$4"
OUT_PREDICTIONS_PATH="$5"

if [[ -z "${CODEX_API_KEY:-}" && -z "${CODEX_MEM_CREDENTIALS_FILE:-}" ]]; then
  echo "ERROR: one of CODEX_API_KEY or CODEX_MEM_CREDENTIALS_FILE is required" >&2
  exit 1
fi

if [[ -n "${CODEX_MEM_CREDENTIALS_FILE:-}" && ! -f "$CODEX_MEM_CREDENTIALS_FILE" ]]; then
  echo "ERROR: CODEX_MEM_CREDENTIALS_FILE set but file missing: $CODEX_MEM_CREDENTIALS_FILE" >&2
  exit 1
fi

if [[ ! -f "$PROBLEM_STATEMENT_FILE" ]]; then
  echo "ERROR: PROBLEM_STATEMENT_FILE not found: $PROBLEM_STATEMENT_FILE" >&2
  exit 1
fi

MODEL_NAME="codex-opus-4-7+codex-mem"

SCRATCH=$(mktemp -d)
REPO_DIR="$SCRATCH/repo"
MEM_DIR="$SCRATCH/.codex-mem"
CODEX_DIR="$SCRATCH/.codex"
mkdir -p "$MEM_DIR" "$CODEX_DIR"

if [[ -n "${CODEX_MEM_CREDENTIALS_FILE:-}" ]]; then
  cp "$CODEX_MEM_CREDENTIALS_FILE" "$CODEX_DIR/.credentials.json"
  chmod 600 "$CODEX_DIR/.credentials.json"
fi

OUTPUT_DIR="${CODEX_MEM_OUTPUT_DIR:-$SCRATCH}"
mkdir -p "$OUTPUT_DIR"

DIFF_OUT="$OUTPUT_DIR/model_patch.diff"
INGEST_LOG="$OUTPUT_DIR/ingest.jsonl"
FIX_LOG="$OUTPUT_DIR/fix.jsonl"

PREDICTION_EMITTED=0
cleanup() {
  local exit_code=$?
  if [[ "$PREDICTION_EMITTED" -ne 1 ]]; then
    : > "$DIFF_OUT" 2>/dev/null || true
    jq -nc \
      --arg id "$INSTANCE_ID" \
      --arg patch "" \
      --arg model "$MODEL_NAME" \
      '{instance_id:$id, model_patch:$patch, model_name_or_path:$model}' \
      >> "$OUT_PREDICTIONS_PATH" || true
  fi
  rm -rf "$SCRATCH"
  exit "$exit_code"
}
trap cleanup EXIT

if ! { git clone --depth 1 --no-single-branch "https://github.com/${REPO_SLUG}.git" "$REPO_DIR" \
    && git -C "$REPO_DIR" fetch --depth 1 origin "$BASE_COMMIT"; }; then
  echo "WARN: shallow fetch failed; falling back to full clone" >&2
  rm -rf "$REPO_DIR"
  git clone "https://github.com/${REPO_SLUG}.git" "$REPO_DIR"
fi
git -C "$REPO_DIR" reset --hard "$BASE_COMMIT"

INGEST_PROMPT="Please learn about the codebase by systematically and thoroughly reading EVERY SOURCE FILE IN FULL, no matter how many there are. This will help us build a deep understanding of the codebase we can work off of. Don't worry about cost. This is critical and non-negotiable."

SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

set +e
(
  cd "$REPO_DIR" && HOME="$SCRATCH" codex \
    --print \
    --session-id "$SESSION_ID" \
    --plugin-dir /opt/codex-mem \
    --permission-mode bypassPermissions \
    --allowedTools "Read,Glob,Grep,Bash(ls *),Bash(wc *)" \
    --max-budget-usd 5.00 \
    --output-format json \
    "$INGEST_PROMPT"
) > "$INGEST_LOG" 2>&1
INGEST_EXIT=$?
set -e

if [[ "$INGEST_EXIT" -ne 0 ]]; then
  echo "WARN: ingest turn exited with $INGEST_EXIT; continuing to fix turn" >&2
fi

PROBLEM=$(cat "$PROBLEM_STATEMENT_FILE")
QUERY=$(printf '%s' "$PROBLEM" | tr -s '[:space:]' ' ' | cut -c1-200)

FIX_PROMPT="/codex-mem:mem-search ${QUERY}

Problem statement:
${PROBLEM}

Using what you've learned from the codebase (see memory above), produce a minimal unified diff that fixes this bug. Edit files in place. Do NOT commit."

set +e
(
  cd "$REPO_DIR" && HOME="$SCRATCH" codex \
    --print \
    --resume "$SESSION_ID" \
    --plugin-dir /opt/codex-mem \
    --permission-mode bypassPermissions \
    --allowedTools "Read,Glob,Grep,Edit,Write,Bash(git *),Bash(ls *)" \
    --max-budget-usd 5.00 \
    --output-format json \
    "$FIX_PROMPT"
) > "$FIX_LOG" 2>&1
FIX_EXIT=$?
set -e

if [[ "$FIX_EXIT" -ne 0 ]]; then
  echo "WARN: fix turn exited with $FIX_EXIT; will still emit prediction row" >&2
fi

git -C "$REPO_DIR" diff > "$DIFF_OUT" || : > "$DIFF_OUT"
DIFF=$(cat "$DIFF_OUT")

jq -nc \
  --arg id "$INSTANCE_ID" \
  --arg patch "$DIFF" \
  --arg model "$MODEL_NAME" \
  '{instance_id:$id, model_patch:$patch, model_name_or_path:$model}' \
  >> "$OUT_PREDICTIONS_PATH"

PREDICTION_EMITTED=1
