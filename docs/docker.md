# Docker

The root `docker-compose.yml` starts Codex-Mem Server beta with a persistent Valkey sidecar.

```sh
docker compose up --build
curl http://127.0.0.1:37777/healthz
```

The server container uses:

- `CODEX_MEM_WORKER_HOST=0.0.0.0`
- `CODEX_MEM_DATA_DIR=/data/codex-mem`
- `CODEX_MEM_QUEUE_ENGINE=bullmq`
- `CODEX_MEM_REDIS_URL=redis://valkey:6379`
- `CODEX_MEM_AUTH_MODE=api-key`

Create an API key inside the container before using protected V1 write routes.
