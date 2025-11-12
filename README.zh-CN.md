# CodexBridge（中文版�?
[English Version](README.md)

CodexBridge 将官�?Codex CLI/SDK 封装�?OpenAI 兼容�?`/v1/chat/completions` 服务，同时保留一个极简 CLI，方便在本地直接对话。任�?OpenAI 客户端（OpenWebUI、Cherry Studio、curl 等）都可以像调用模型一样使�?Codex�?
## 功能亮点

- **OpenAI 兼容 API**：完整实�?`/v1/chat/completions`（同�?+ SSE）和 `/v1/models`�?- **会话持久�?*：通过 `session_id` / `conversation_id` / `thread_id` / `user` 任一字段即可复用 Codex 线程；不传则使用一次性线程�?- **多模态输�?*：支�?`image_url`/`local_image` 内容块（HTTP(S)、`file://`、`data:` URI、本地路径），自动转�?Codex �?`local_image` 附件�?- **结构化输�?*：把 OpenAI `response_format`（JSON Schema / JSON 对象）映射到 Codex �?`outputSchema`，强制返回机器可�?JSON�?- **沙箱可配�?*：通过环境变量控制文件权限、工作目录、联网、Web 搜索、命令审批策略�?- **CLI 快速对�?*：`npm run codex:chat` 提供单线�?REPL，适合本地调试�?- **数据自托�?*：Codex 线程保存�?`~/.codex/sessions`，桥接层映射位于 `.codex_threads.json`�?
## 运行前提

- Node.js 18+
- 已安装并登录�?Codex CLI（与桥接器运行在同一台机器）
- npm（或自行改写脚本以适配 pnpm/yarn�?
## 安装

```bash
git clone https://github.com/begonia599/CodexBridge
cd codexbridge
npm install
cp .env.example .env
cp .env .env.local   # 可选：保留自定义配�?```

�?`.env` / `.env.local` 中设置默认值，开放服务前请修改示�?API key�?
## CLI 对话

```bash
npm run codex:chat
```

- 直接输入自然语言，Codex 即时回复�?- `/reset` 创建新的 Codex 线程�?- `/exit` 退�?CLI�?
线程 ID 缓存�?`.codex_thread.json`，重�?CLI 依然保持上下文�?
## HTTP 桥接服务

```bash
npm run codex:server
```

- 默认端口：`8080`（可�?`PORT` 覆盖�?- 健康检查：`GET /health`
- 会话映射：`.codex_threads.json`（删除即可清空桥接层 session�?
### 普通请�?
```bash
curl http://localhost:8080/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer 123321" \
  -d '{"model":"gpt-5-codex:medium","session_id":"demo","messages":[{"role":"user","content":"ls"}]}'
```

- 模型 ID 可写�?`模型:推理等级`（如 `gpt-5-codex:low`）；省略 `:等级` 时使�?`.env` 的默认值�?- `session_id` / `conversation_id` / `thread_id` / `user` 任一可作为会话标识；提供后会话持久化，缺省则退回一次性线程（把整�?`messages` 展开�?`[ROLE]` 块发送，Codex 不记录历史）�?- 传入 `session_id` 时桥接器只会把最新一�?user 消息（附带所�?system 提示）交�?Codex，历史上下文�?Codex 线程自身维护�?
### session_id 与会话持久化

- 建议在前�?生产环境启用 `CODEX_REQUIRE_SESSION_ID=true`，强制每个请求都携带会话 ID，避免上下文混用�?- 可以在请求体字段（`session_id` / `conversation_id` / `thread_id` / `user`）或请求头（`x-session-id`、`session-id`、`x-conversation-id`、`x-thread-id`、`x-user-id`）中提供 IDs，利用中间件统一注入更方便�?- 会话 ID 必须是非空字符串（如 UUID、用�?ID、聊�?ID），请勿传递纯数字或对象�?- 如果全部缺省�?`CODEX_REQUIRE_SESSION_ID=false`，桥接器会转为临时线程：�?`messages` 展开�?`[ROLE]` 块一次性发送，Codex 不会持久化该上下文�?
### 流式输出

```bash
curl -N http://localhost:8080/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer 123321" \
  -d '{"model":"gpt-5-codex:high","session_id":"stream","stream":true,"messages":[{"role":"user","content":"一步步说明如何使用 npm init 创建项目"}]}'
```

响应�?SSE（`data: {...}`），�?`data: [DONE]` 结束�?
### 多模态输�?
`messages[*].content` 支持图文混合�?
- `{"type":"image_url","image_url":{"url":"https://..."}}`：HTTP(S) / `file://` / `data:image/...` / 相对或绝对路径�?- `{"type":"local_image","path":"./relative/or/absolute.jpg"}`（或 `image_path`）�?
远程资源会下载到临时目录，转�?`local_image` 后在回合结束时自动删除�?
### 结构化输�?
设置 `response_format`（或顶层 `output_schema`）即可利�?Codex �?`outputSchema` 功能，强制返回符�?JSON Schema 的结果�?
### 联网�?Web 搜索

- `CODEX_NETWORK_ACCESS=true` 允许 Codex 执行联网命令（`curl`、`git clone` 等）�?- `CODEX_WEB_SEARCH=true` 允许使用内置 Web 搜索�?
默认均为 `false`�?
## 源码部署

```bash
cp .env.example .env
# 编辑 .env 后启动服�?npm run codex:server
```

如需常驻后台，可搭配 `pm2`、`systemd`、`nohup` 等守护方式运行；若需�?HTTPS，可在前面挂 Nginx / Caddy 反向代理 `localhost:8080`。需�?CLI 配合时同时执�?`npm run codex:chat` 即可�?
## Docker

### Docker Compose

```bash
docker compose up -d

# 查看日志
docker compose logs -f codexbridge
```

> 建议�?PowerShell 7+ / 新版 Docker Desktop 上使�?`docker compose`；如需旧版 `docker-compose` 命令，可自行替换�?> Compose 会把 Codex 状态挂载到 `./codex-data`（自动创建）。删除该目录即可清空所�?Codex 线程�?
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

- Linux/macOS �?`%LOCALAPPDATA%\Codex` 换成 `~/.codex`�?- 把希�?Codex 访问的项目目录挂载到 `/workspace`（或调整 `CODEX_WORKDIR`）�?- Codex 线程都保存在挂载�?`.codex` 目录内，方便备份或共享�?
## 环境变量

| 变量 | 默认�?| 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 端口 |
| `CODEX_MODEL` | `gpt-5-codex` | 默认模型 |
| `CODEX_REASONING` | `medium` | 默认推理等级 (`low` / `medium` / `high`) |
| `CODEX_BRIDGE_API_KEY` | `123321` | API key（`Authorization: Bearer` / `x-api-key`�?|
| `CODEX_SKIP_GIT_CHECK` | `true` | 是否跳过 Codex“受信任 Git 仓库”检�?|
| `CODEX_SANDBOX_MODE` | `read-only` | `read-only` / `workspace-write` / `danger-full-access` |
| `CODEX_WORKDIR` | �?| 限定 Codex 工作目录 |
| `CODEX_NETWORK_ACCESS` | `false` | 允许 Codex 联网 |
| `CODEX_WEB_SEARCH` | `false` | 允许 Codex 使用 Web Search |
| `CODEX_APPROVAL_POLICY` | `never` | `never` / `on-request` / `on-failure` / `untrusted` |
| `CODEX_LOG_REQUESTS` | `false` | 打印请求 payload 便于调试 |
| `CODEX_REQUIRE_SESSION_ID` | `false` | `true` 时缺�?session ID 会直�?400 |
| `CODEX_JSON_LIMIT` | `10mb` | `express.json()` 请求体大小上�?|

## 常见问题

- **413 PayloadTooLargeError**：增�?`CODEX_JSON_LIMIT`，尤其是发�?base64 图片时�?- **“Invalid or missing API key�?*：确保请求携带正确的 `Authorization: Bearer <KEY>` �?`x-api-key`�?- **Codex �?Git 仓库限制**：仅在可信仓库内运行时才关闭 `CODEX_SKIP_GIT_CHECK`�?- **需要重置所有会�?*：停止服务后删除 `.codex_threads.json` �?`~/.codex/sessions`�?
## 许可�?
仅限非商业用途，详见 [LICENSE](LICENSE)。若需商用，请先联�?begonia 获取书面授权�?
欢迎 Issue / PR！如果你在其他工具中集成�?CodexBridge 或需要更多特性，欢迎反馈�?**
## 支持与联�?
- 仓库地址：https://github.com/begonia599/CodexBridge
- 邮箱：`begonia@bgnhub.me`

如果你在使用 CodexBridge 时遇到问题、希望扩展功能、或想要在此基础上二次开发，欢迎随时联系，我很乐意提供帮助，也欢迎各路开发者共同完善这个项目�?**
