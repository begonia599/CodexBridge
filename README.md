# CodexBridge

[ä¸­æ–‡ç‰ˆæœ¬](README.zh-CN.md)

CodexBridge wraps the official Codex CLI/SDK and exposes it via an OpenAI-compatible `/v1/chat/completions` endpoint. It also ships with a tiny CLI so you can talk to Codex locally. Any OpenAI-style client (OpenWebUI, Cherry Studio, curl, etc.) can treat Codex as if it were a standard model.

## Highlights

- **OpenAI-compatible API** â€?`/v1/chat/completions` (sync + SSE) plus `/v1/models`.
- **Persistent sessions** â€?`session_id` / `conversation_id` / `thread_id` / `user` keep Codex context; omit them for ephemeral runs.
- **Multimodal input** â€?Accepts `image_url` / `local_image` blocks (HTTP(S), `file://`, `data:` URIs, local paths) and converts them to Codex `local_image`.
- **Structured output** â€?Maps OpenAI `response_format` (JSON schema / JSON object) to Codex `outputSchema`.
- **Configurable sandbox** â€?Environment variables control filesystem access, working directory, networking, web search, approval policy.
- **CLI chat** â€?`npm run codex:chat` is a single-thread REPL for local experiments.
- **Self-hosted storage** â€?Codex sessions stay under `~/.codex/sessions`; bridge mappings live in `.codex_threads.json`.

## Requirements

- Node.js 18+
- Codex CLI installed & authenticated on the same machine
- npm (or adapt scripts for pnpm/yarn)

## Installation

```bash
git clone https://github.com/begonia599/CodexBridge
cd codexbridge
npm install
cp .env.example .env
cp .env .env.local   # optional custom config
```

Edit `.env` / `.env.local` to set defaults. Replace the sample API key before exposing the server.

## CLI Chat

```bash
npm run codex:chat
```

- Type natural language commands; Codex replies inline.
- `/reset` starts a new Codex thread.
- `/exit` quits.

Thread IDs persist in `.codex_thread.json`, so closing and reopening the CLI keeps context.

## HTTP Bridge

```bash
npm run codex:server
```

- Default port: `8080` (`PORT` overrides)
- Health check: `GET /health`
- Session map: `.codex_threads.json` (delete to wipe bridge-level sessions)

### Basic request

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer 123321" \
  -d '{"model":"gpt-5-codex:medium","session_id":"demo","messages":[{"role":"user","content":"ls"}]}'
```

Notes:

- Model IDs encode reasoning effort as `model:level` (e.g. `gpt-5-codex:low`). Omitting `:level` falls back to `.env` defaults.
- Any of `session_id`, `conversation_id`, `thread_id`, or `user` identifies a session. Provide one to resume context; omit all to create an ephemeral run.
- With `session_id`, the bridge sends only the latest user turn (system prompts prepended) so Codex manages history. Without it, the entire message history is flattened into `[ROLE]` blocks and sent as a single prompt.

### Session IDs & persistence

- In production/front-end setups, enable `CODEX_REQUIRE_SESSION_ID=true` so every request must include a session identifier.
- IDs can be sent in the JSON body (`session_id` / `conversation_id` / `thread_id` / `user`) or via headers (`x-session-id`, `session-id`, `x-conversation-id`, `x-thread-id`, `x-user-id`). Headers are convenient for global middleware.
- IDs must be non-empty strings (UUID, user ID, chat ID, etc.). Avoid numeric-only payloads or nested objects.
- If all identifiers are missing and `CODEX_REQUIRE_SESSION_ID` is `false`, the bridge creates an ephemeral thread (history flattened, no persistence).

### Streaming

```bash
curl -N http://localhost:8080/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer 123321" \
  -d '{"model":"gpt-5-codex:high","session_id":"stream","stream":true,"messages":[{"role":"user","content":"Explain how to run npm init step by step."}]}'
```

Response is SSE (`data: {...}`) ending with `data: [DONE]`.

### Multimodal input

- `{"type":"image_url","image_url":{"url":"https://..."}}` â€?HTTP(S) / `file://` / `data:image/...` / relative/absolute paths.
- `{"type":"local_image","path":"./relative/or/absolute.jpg"}` (or `image_path`).

Remote resources are downloaded to a temp directory, passed to Codex as `local_image`, then cleaned up.

```json
{
  "model": "gpt-5-codex",
  "session_id": "vision-demo",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Describe this UI screenshot." },
        { "type": "image_url", "image_url": { "url": "https://example.com/screenshot.png" } }
      ]
    }
  ]
}
```

### Structured JSON output

CodexBridge forwards OpenAI `response_format` (or `output_schema`) to Codex `outputSchema`.

```json
{
  "model": "gpt-5-codex",
  "session_id": "lint",
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "lint_report",
      "schema": {
        "type": "object",
        "properties": {
          "summary": { "type": "string" },
          "status": { "type": "string", "enum": ["ok", "action_required"] }
        },
        "required": ["summary", "status"],
        "additionalProperties": false
      }
    }
  },
  "messages": [
    { "role": "user", "content": "Check src/ for lint problems and output JSON following the schema." }
  ]
}
```

- `type: "json_schema"` requires `json_schema.schema` (or `schema`). Missing/invalid schemas return HTTP 400.
- `type: "json_object"` is shorthand for `{ "type": "object" }`.

### Networking & search

- `CODEX_NETWORK_ACCESS=true` allows networked commands (`curl`, `git clone`, API calls).
- `CODEX_WEB_SEARCH=true` enables Codexâ€™s built-in browsing tool.

Both default to `false`.

## Source deployment

```bash
cp .env.example .env
# edit .env as needed, then:
npm run codex:server
```

Keep the process running via your preferred supervisor (`pm2`, `systemd`, `forever`, etc.), or use a reverse proxy (Nginx/Caddy) in front of `localhost:8080` if you need HTTPS. Run `npm run codex:chat` alongside the server when you want CLI interaction in the same workspace.

## Docker

### Docker Compose

```bash
docker compose up -d

# view logs
docker compose logs -f codexbridge
```

> Use `docker compose` on PowerShell 7+ / modern Docker Desktop. Replace with `docker-compose` if you rely on the legacy command.
> Compose mounts Codex state under `./codex-data` (auto-created). Delete this directory to reset Codex threads.

### Docker CLI

```bash
docker build -t codexbridge .

docker run --rm -p 8080:8080 \
  --env-file .env \
  -v "%cd%":/workspace \
  -v "%LOCALAPPDATA%\Codex":/root/.codex \
  -w /workspace \
  codexbridge
```

Tips:

- On Linux/macOS replace `%LOCALAPPDATA%\Codex` with `~/.codex`.
- Mount repositories you want Codex to access under `/workspace` (or set `CODEX_WORKDIR`).
- Codex sessions persist inside the mounted `.codex` directory.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `CODEX_MODEL` | `gpt-5-codex` | Default model |
| `CODEX_REASONING` | `medium` | Default reasoning (`low` / `medium` / `high`) |
| `CODEX_BRIDGE_API_KEY` | `123321` | API key for `Authorization: Bearer` / `x-api-key` |
| `CODEX_SKIP_GIT_CHECK` | `true` | Skip Codex â€œtrusted Git repoâ€?requirement |
| `CODEX_SANDBOX_MODE` | `read-only` | `read-only` / `workspace-write` / `danger-full-access` |
| `CODEX_WORKDIR` | empty | Force Codex threads to run inside this directory |
| `CODEX_NETWORK_ACCESS` | `false` | Allow networked commands |
| `CODEX_WEB_SEARCH` | `false` | Allow built-in web search |
| `CODEX_APPROVAL_POLICY` | `never` | `never` / `on-request` / `on-failure` / `untrusted` |
| `CODEX_LOG_REQUESTS` | `false` | Log incoming payloads |
| `CODEX_REQUIRE_SESSION_ID` | `false` | Require session identifiers (`true` recommended for production) |
| `CODEX_JSON_LIMIT` | `10mb` | `express.json()` body limit |

## Troubleshooting

- **413 PayloadTooLargeError** â€?Increase `CODEX_JSON_LIMIT`, especially when sending base64 images.
- **â€œInvalid or missing API keyâ€?* â€?Provide `Authorization: Bearer <CODEX_BRIDGE_API_KEY>` or `x-api-key`.
- **Codex refuses to run (Git check)** â€?Only disable `CODEX_SKIP_GIT_CHECK` if the working directory is a trusted repo.
- **Need a clean slate** â€?Stop the server and delete `.codex_threads.json` and/or `~/.codex/sessions`.

## License

Non-commercial use only. See [LICENSE](LICENSE) for full terms. Commercial usage requires prior written permission from begonia.

Contributions are welcome! If you extend CodexBridge or integrate it with other tools, feel free to open issues or PRs.

## Support & contact

- Repository: https://github.com/begonia599/CodexBridge
- Email: `begonia@bgnhub.me`

Feel free to reach out if you run into problems, want new features, or plan to fork and rework CodexBridge. Iâ€™m happy to help and love seeing derivative projects.
