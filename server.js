#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import express from "express";
import { fileURLToPath } from "node:url";
import { Codex } from "@openai/codex-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_MODEL = process.env.CODEX_MODEL ?? "gpt-5-codex";
const DEFAULT_REASONING =
  process.env.CODEX_REASONING ??
  process.env.CODEX_MODEL_REASONING ??
  "medium";
const PORT = Number(process.env.PORT ?? 8080);
const STATE_FILE = path.join(__dirname, ".codex_threads.json");
const SHOULD_SKIP_GIT =
  process.env.CODEX_SKIP_GIT_CHECK === "false" ? false : true;
const API_KEY = process.env.CODEX_BRIDGE_API_KEY ?? "123321";
const SANDBOX_MODE = normalizeSandboxMode(
  process.env.CODEX_SANDBOX_MODE ?? "danger-full-access",
);
const WORKING_DIRECTORY = resolveWorkingDirectory(process.env.CODEX_WORKDIR);
const NETWORK_ACCESS = readBooleanEnv(
  process.env.CODEX_NETWORK_ACCESS,
  false,
);
const WEB_SEARCH = readBooleanEnv(process.env.CODEX_WEB_SEARCH, false);
const APPROVAL_POLICY = normalizeApprovalPolicy(
  process.env.CODEX_APPROVAL_POLICY ?? "never",
);
const LOG_REQUESTS = readBooleanEnv(process.env.CODEX_LOG_REQUESTS, false);
const REQUIRE_SESSION_ID = readBooleanEnv(
  process.env.CODEX_REQUIRE_SESSION_ID,
  false,
);
const JSON_LIMIT = process.env.CODEX_JSON_LIMIT ?? "10mb";

const MODEL_PRESETS = [
  {
    id: "gpt-5-codex",
    label: "GPT-5-Codex",
    description: "面向复杂开发任务的旗舰 Codex，适合深度修改代码与调用多种工具。",
    reasonings: [
      { level: "low", label: "Low", description: "响应最快，推理深度最低，适合简单改动。" },
      { level: "medium", label: "Medium", description: "推理深度与速度折中（默认）。" },
      { level: "high", label: "High", description: "推理深度最高，适合疑难杂症与大型重构。" },
    ],
    defaultReasoning: "medium",
  },
  {
    id: "gpt-5-codex-mini",
    label: "GPT-5-Codex-Mini",
    description: "轻量版 Codex，适合日常增删改查与脚本编辑，成本更低。",
    reasonings: [
      { level: "low", label: "Low", description: "最快速的响应，适合简单编辑。" },
      { level: "medium", label: "Medium", description: "在速度与质量之间取得平衡（默认）。" },
    ],
    defaultReasoning: "medium",
  },
  {
    id: "gpt-5",
    label: "GPT-5",
    description: "通用型 GPT-5，覆盖广泛常识与自然语言任务，侧重综合推理。",
    reasonings: [
      { level: "low", label: "Low", description: "高速度模式，适合问答/总结等轻负载任务。" },
      { level: "medium", label: "Medium", description: "标准推理深度（默认），适合大多数对话场景。" },
      { level: "high", label: "High", description: "最大化推理能力，适合复杂需求或长篇创作。" },
    ],
    defaultReasoning: "medium",
  },
];

const codex = new Codex();
const inMemoryThreads = new Map();
const persistedThreadIds = await loadState();
const saveQueue = createSaveQueue();

const app = express();
app.use(express.json({ limit: JSON_LIMIT }));
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!API_KEY) return next();
  const authHeader = req.get("authorization") ?? "";
  let suppliedKey = null;
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    suppliedKey = authHeader.slice(7).trim();
  } else if (req.get("x-api-key")) {
    suppliedKey = req.get("x-api-key");
  }
  if (suppliedKey !== API_KEY) {
    return res.status(401).json({
      error: {
        message: "Invalid or missing API key.",
        type: "unauthorized",
      },
    });
  }
  return next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/v1/models", (_req, res) => {
  const flattened = MODEL_PRESETS.flatMap((model) =>
    model.reasonings.map((reasoning) => ({
      object: "model",
      id: `${model.id}:${reasoning.level}`,
      label: `${model.label} · ${reasoning.label}`,
      description: `${model.description} (Reasoning: ${reasoning.label})`,
      base_model: model.id,
      reasoning: reasoning.level,
      default_reasoning: model.defaultReasoning,
    })),
  );

  res.json({
    object: "list",
    data: flattened,
    defaults: {
      model: `${DEFAULT_MODEL}:${DEFAULT_REASONING}`,
    },
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  const { messages, model, reasoning_effort, stream } = req.body ?? {};

  if (LOG_REQUESTS) {
    console.log(
      "[Codex Bridge] incoming chat request:",
      JSON.stringify(
        {
          session_id:
            req.body?.session_id ??
            req.body?.conversation_id ??
            req.body?.thread_id ??
            req.body?.user ??
            null,
          model,
          reasoning_effort: reasoning_effort ?? req.body?.model_reasoning_effort,
          stream: Boolean(stream),
          message_count: Array.isArray(messages) ? messages.length : 0,
          raw: req.body,
        },
        null,
        2,
      ),
    );
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: "Request body must include a non-empty messages array.",
        type: "invalid_request_error",
      },
    });
  }

  let sessionId = resolveSessionId(req);
  const sessionProvided = Boolean(sessionId);
  if (!sessionProvided && REQUIRE_SESSION_ID) {
    return res.status(400).json({
      error: {
        message:
          "session_id (or conversation_id / thread_id / user) is required in this deployment.",
        type: "missing_session_id",
      },
    });
  }
  if (!sessionProvided) {
    sessionId = `ephemeral-${crypto.randomUUID()}`;
  }

  let normalizedMessages;
  try {
    normalizedMessages = await normalizeMessages(messages);
  } catch (error) {
    return res.status(400).json({
      error: {
        message: error?.message ?? "Invalid message attachments.",
        type: "invalid_request_error",
      },
    });
  }

  let outputSchema = null;
  try {
    outputSchema = resolveOutputSchemaFromBody(req.body);
  } catch (error) {
    return res.status(400).json({
      error: {
        message: error?.message ?? "Invalid response_format schema.",
        type: "invalid_request_error",
      },
    });
  }

  const latestUserPrompt = extractLatestUserContent(normalizedMessages);
  const latestUserInputs = extractLatestUserInputs(normalizedMessages);
  const conversationPrompt = buildConversationPrompt(normalizedMessages);
  const conversationInputs = buildConversationInputs(normalizedMessages);
  const systemPrompt = buildSystemPrompt(normalizedMessages);
  const finalPrompt = sessionProvided
    ? mergePrompts(systemPrompt, latestUserPrompt)
    : conversationPrompt;
  const finalStructuredPrompt = sessionProvided
    ? mergeStructuredPrompts(systemPrompt, latestUserInputs)
    : conversationInputs;
  if (
    !finalPrompt &&
    (!finalStructuredPrompt || finalStructuredPrompt.length === 0)
  ) {
    return res.status(400).json({
      error: {
        message: "Messages must include at least one user entry.",
        type: "invalid_request_error",
      },
    });
  }
  const codexInput = finalStructuredPrompt ?? finalPrompt;
  const turnOptions = {};
  if (outputSchema) turnOptions.outputSchema = outputSchema;
  const attachmentCleanups = collectAttachmentCleanups(normalizedMessages);
  const { resolvedModel, resolvedReasoning } = resolveModelAndReasoning({
    model: model ?? DEFAULT_MODEL,
    reasoning: reasoning_effort ?? req.body?.model_reasoning_effort,
  });
  const threadOptions = {
    skipGitRepoCheck: SHOULD_SKIP_GIT,
    model: resolvedModel,
    modelReasoningEffort: resolvedReasoning,
  };
  if (SANDBOX_MODE) threadOptions.sandboxMode = SANDBOX_MODE;
  if (WORKING_DIRECTORY) threadOptions.workingDirectory = WORKING_DIRECTORY;
  if (NETWORK_ACCESS !== null)
    threadOptions.networkAccessEnabled = NETWORK_ACCESS;
  if (WEB_SEARCH !== null) threadOptions.webSearchEnabled = WEB_SEARCH;
  if (APPROVAL_POLICY) threadOptions.approvalPolicy = APPROVAL_POLICY;

  const threadRecord = await getOrCreateThread(sessionId, threadOptions, {
    ephemeral: !sessionProvided,
  });
  const { thread } = threadRecord;

  if (stream) {
    if (LOG_REQUESTS) {
      console.log(
        "[Codex Bridge] runStreamed payload:",
        JSON.stringify(
          {
            session_id: sessionId,
            model: threadOptions.model,
            reasoning: threadOptions.modelReasoningEffort,
            sandboxMode: threadOptions.sandboxMode,
            workingDirectory: threadOptions.workingDirectory,
            networkAccessEnabled: threadOptions.networkAccessEnabled,
            webSearchEnabled: threadOptions.webSearchEnabled,
            approvalPolicy: threadOptions.approvalPolicy,
            prompt: codexInput,
            response_format: outputSchema ? "json_schema" : "text",
            output_schema: outputSchema,
            ephemeral: !sessionProvided,
          },
          null,
          2,
        ),
      );
    }
    await handleStreamResponse({
      res,
      thread,
      threadOptions,
      sessionId,
      prompt: codexInput,
      shouldPersist: sessionProvided,
      turnOptions,
      cleanupTasks: attachmentCleanups,
    });
    return;
  }

  try {
    if (LOG_REQUESTS) {
      console.log(
        "[Codex Bridge] run payload:",
        JSON.stringify(
          {
            session_id: sessionId,
            model: threadOptions.model,
            reasoning: threadOptions.modelReasoningEffort,
            sandboxMode: threadOptions.sandboxMode,
            workingDirectory: threadOptions.workingDirectory,
            networkAccessEnabled: threadOptions.networkAccessEnabled,
            webSearchEnabled: threadOptions.webSearchEnabled,
            approvalPolicy: threadOptions.approvalPolicy,
            prompt: codexInput,
            response_format: outputSchema ? "json_schema" : "text",
            output_schema: outputSchema,
            ephemeral: !sessionProvided,
          },
          null,
          2,
        ),
      );
    }
    const turn = await thread.run(codexInput, turnOptions);
    if (sessionProvided) {
      await persistThreadIdIfNeeded(sessionId, thread);
    }

    const usage = formatUsage(turn?.usage);

    return res.json({
      id: `chatcmpl-${thread.id ?? crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: threadOptions.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: extractAssistantResponse(turn),
          },
          finish_reason: "stop",
        },
      ],
      usage,
    });
  } catch (error) {
    console.error("Codex run failed:", error);
    return res.status(500).json({
      error: {
        message: error?.message ?? "Codex execution failed.",
        type: "codex_execution_error",
      },
    });
  } finally {
    await cleanupAttachmentFiles(attachmentCleanups);
  }
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: {
      message: err?.message ?? "Unexpected server error.",
      type: "internal_server_error",
    },
  });
});

await new Promise((resolve) => {
  app.listen(PORT, () => {
    console.log(
      `Codex OpenAI-compatible bridge listening on http://localhost:${PORT}`,
    );
    resolve();
  });
});

function normalizeReasoning(value) {
  if (!value) return null;
  const lowered = String(value).toLowerCase();
  if (["low", "medium", "high"].includes(lowered)) {
    return lowered;
  }
  return null;
}

function buildConversationPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const lines = [];
  for (const entry of messages) {
    if (!entry?.role || !entry?.text) continue;
    lines.push(`[${entry.role.toUpperCase()}]\n${entry.text}`.trim());
  }
  return lines.length ? lines.join("\n\n") : null;
}

function buildConversationInputs(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const inputs = [];
  for (const entry of messages) {
    if (!entry?.role) continue;
    const label = `[${entry.role.toUpperCase()}]`;
    let prefixed = false;
    if (entry.text) {
      inputs.push({
        type: "text",
        text: `${label}\n${entry.text}`.trim(),
      });
      prefixed = true;
    }
    if (Array.isArray(entry.attachments) && entry.attachments.length > 0) {
      if (!prefixed) {
        inputs.push({ type: "text", text: label });
        prefixed = true;
      }
      for (const attachment of entry.attachments) {
        if (attachment?.path) {
          inputs.push({ type: "local_image", path: attachment.path });
        }
      }
    }
  }
  return inputs.length ? inputs : null;
}

function extractLatestUserContent(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (entry?.role !== "user") continue;
    if (entry?.text) return entry.text;
  }
  return null;
}

function extractLatestUserInputs(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (entry?.role !== "user") continue;
    const inputs = [];
    if (entry?.text) {
      inputs.push({ type: "text", text: entry.text });
    }
    if (Array.isArray(entry?.attachments)) {
      for (const attachment of entry.attachments) {
        if (attachment?.path) {
          inputs.push({ type: "local_image", path: attachment.path });
        }
      }
    }
    return inputs.length ? inputs : null;
  }
  return null;
}

function buildSystemPrompt(messages) {
  if (!Array.isArray(messages)) return null;
  const blocks = [];
  for (const entry of messages) {
    if (entry?.role !== "system" || !entry?.text) continue;
    blocks.push(`[SYSTEM]\n${entry.text}`.trim());
  }
  return blocks.length ? blocks.join("\n\n") : null;
}

function mergePrompts(systemPrompt, userPrompt) {
  if (!userPrompt) return null;
  if (!systemPrompt) return userPrompt;
  return `${systemPrompt}\n\n${userPrompt}`;
}

function mergeStructuredPrompts(systemPrompt, userInputs) {
  const inputs = [];
  if (systemPrompt) {
    inputs.push({ type: "text", text: systemPrompt });
  }
  if (Array.isArray(userInputs) && userInputs.length > 0) {
    inputs.push(...userInputs);
  }
  return inputs.length ? inputs : null;
}

function resolveSessionId(req) {
  const body = req?.body ?? {};
  const headers = req?.headers ?? {};
  const readHeader = (key) => {
    const value = headers[String(key).toLowerCase()];
    if (value === undefined || value === null) return null;
    const text = Array.isArray(value) ? value[0] : value;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  };
  return (
    body?.session_id ??
    body?.conversation_id ??
    body?.thread_id ??
    body?.user ??
    readHeader("x-session-id") ??
    readHeader("session-id") ??
    readHeader("x-conversation-id") ??
    readHeader("x-thread-id") ??
    readHeader("x-user-id") ??
    null
  );
}

function getModelPreset(modelId) {
  if (!modelId) return null;
  const normalized = String(modelId).toLowerCase();
  return MODEL_PRESETS.find((preset) => preset.id === normalized) ?? null;
}

function resolveModelAndReasoning({ model, reasoning }) {
  if (!model) {
    return {
      resolvedModel: DEFAULT_MODEL,
      resolvedReasoning: DEFAULT_REASONING,
    };
  }

  const split = String(model).toLowerCase().split(":");
  const modelId = split[0];
  const appendedReasoning = split[1];
  const modelPreset = getModelPreset(modelId) ?? getModelPreset(DEFAULT_MODEL);

  const requestedReasoning = normalizeReasoning(reasoning ?? appendedReasoning);
  const allowedReasoning =
    requestedReasoning &&
    modelPreset?.reasonings?.some((r) => r.level === requestedReasoning)
      ? requestedReasoning
      : modelPreset?.defaultReasoning ?? DEFAULT_REASONING;

  return {
    resolvedModel: modelPreset?.id ?? DEFAULT_MODEL,
    resolvedReasoning: allowedReasoning,
  };
}

function readBooleanEnv(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeSandboxMode(value) {
  if (!value) return null;
  const normalized = String(value).toLowerCase();
  const allowed = [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ];
  return allowed.includes(normalized) ? normalized : null;
}

function normalizeApprovalPolicy(value) {
  if (!value) return null;
  const normalized = String(value).toLowerCase();
  const allowed = ["never", "on-request", "on-failure", "untrusted"];
  return allowed.includes(normalized) ? normalized : null;
}

function resolveWorkingDirectory(value) {
  if (!value) return null;
  if (path.isAbsolute(value)) return value;
  return path.resolve(__dirname, value);
}

function resolveOutputSchemaFromBody(body) {
  if (!body || typeof body !== "object") return null;
  if (body.output_schema !== undefined) {
    return ensureJsonSchemaObject(body.output_schema, "output_schema");
  }
  if (body.outputSchema !== undefined) {
    return ensureJsonSchemaObject(body.outputSchema, "outputSchema");
  }
  const responseFormat = body.response_format ?? body.responseFormat;
  if (responseFormat === undefined || responseFormat === null) return null;
  if (typeof responseFormat === "string") {
    const normalized = responseFormat.toLowerCase();
    if (normalized === "json_schema") {
      throw new Error(
        "response_format \"json_schema\" requires an accompanying schema.",
      );
    }
    if (normalized === "json_object") {
      return { type: "object" };
    }
    return null;
  }
  if (!isPlainObject(responseFormat)) {
    throw new Error("response_format must be an object when provided.");
  }
  const type =
    typeof responseFormat.type === "string"
      ? responseFormat.type.toLowerCase()
      : null;
  if (type === "json_schema" || responseFormat.json_schema || responseFormat.schema) {
    const schemaCandidate =
      responseFormat?.json_schema?.schema ??
      responseFormat?.schema ??
      responseFormat?.json_schema;
    if (!schemaCandidate) {
      throw new Error(
        "response_format.json_schema.schema must be provided for type=json_schema.",
      );
    }
    return ensureJsonSchemaObject(
      schemaCandidate,
      "response_format.json_schema.schema",
    );
  }
  if (type === "json_object") {
    return { type: "object" };
  }
  if (type && type !== "text") {
    throw new Error(`Unsupported response_format type "${responseFormat.type}".`);
  }
  if (responseFormat.schema) {
    return ensureJsonSchemaObject(responseFormat.schema, "response_format.schema");
  }
  return null;
}

function ensureJsonSchemaObject(candidate, label = "output schema") {
  if (!isPlainObject(candidate)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return candidate;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const normalized = [];
  for (let i = 0; i < messages.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    normalized.push(await normalizeMessageEntry(messages[i], i));
  }
  return normalized;
}

async function normalizeMessageEntry(entry, index) {
  if (!entry || typeof entry !== "object") {
    return { role: null, text: null, attachments: [] };
  }
  const role =
    typeof entry.role === "string" ? entry.role.trim().toLowerCase() : null;
  const text = extractTextContent(entry);
  const attachments = await extractImageAttachments(entry, index);
  return { role, text, attachments };
}

function extractTextContent(entry) {
  if (typeof entry?.content === "string") return entry.content;
  if (!Array.isArray(entry?.content)) return null;
  const textBlocks = entry.content
    .filter((block) => block?.type === "text" && block?.text)
    .map((block) => block.text);
  if (textBlocks.length === 0) return null;
  return textBlocks.join("\n");
}

async function extractImageAttachments(entry, index) {
  if (!Array.isArray(entry?.content)) return [];
  const attachments = [];
  for (const block of entry.content) {
    // eslint-disable-next-line no-await-in-loop
    const resolved = await resolveImageBlock(block, index);
    if (resolved) attachments.push(resolved);
  }
  return attachments;
}

async function resolveImageBlock(block, index) {
  if (!block || typeof block !== "object") return null;
  const type = block.type;
  if (type === "local_image") {
    const candidate =
      typeof block.path === "string"
        ? block.path
        : typeof block.image_path === "string"
          ? block.image_path
          : null;
    if (!candidate) {
      throw new Error(`Message ${index + 1} local_image block is missing path.`);
    }
    return { path: resolveImagePath(candidate) };
  }
  if (type === "image_url" || type === "input_image") {
    const candidate =
      typeof block.image_url?.url === "string"
        ? block.image_url.url
        : typeof block.url === "string"
          ? block.url
          : null;
    if (!candidate) {
      throw new Error(`Message ${index + 1} image_url block is missing url.`);
    }
    return resolveImageUrlReference(candidate);
  }
  return null;
}

function resolveImagePath(value) {
  if (typeof value !== "string") {
    throw new Error("Image reference must be a string path or URL.");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Image reference cannot be empty.");
  }
  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }
  if (/^[a-z]+:\/\//i.test(trimmed)) {
    const scheme = trimmed.split(":")[0].toLowerCase();
    if (scheme !== "file") {
      throw new Error(
        "Only file:// URLs, HTTP(S) URLs, or local file paths are supported for images.",
      );
    }
    try {
      return fileURLToPath(trimmed);
    } catch {
      throw new Error("Invalid file:// URL provided for image attachment.");
    }
  }
  if (/^[a-z]+:/i.test(trimmed)) {
    throw new Error(
      "Only file:// URLs, HTTP(S) URLs, or local file paths are supported for images.",
    );
  }
  const baseDir = WORKING_DIRECTORY ?? process.cwd();
  return path.resolve(baseDir, trimmed);
}

async function resolveImageUrlReference(value) {
  if (typeof value !== "string") {
    throw new Error("Image reference must be a string path or URL.");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Image reference cannot be empty.");
  }
  if (trimmed.startsWith("data:")) {
    return createTempFileFromDataUrl(trimmed);
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return downloadImageToTempFile(trimmed);
  }
  return { path: resolveImagePath(trimmed) };
}

async function createTempFileFromDataUrl(dataUrl) {
  const match = /^data:(?<mime>[^;]+);base64,(?<payload>.+)$/i.exec(dataUrl);
  if (!match?.groups?.payload) {
    throw new Error("Invalid data URL provided for image attachment.");
  }
  const mime = match.groups.mime;
  const base64 = match.groups.payload.replace(/\s+/g, "");
  const buffer = Buffer.from(base64, "base64");
  return writeTempImageFile(buffer, inferExtensionFromMime(mime));
}

async function downloadImageToTempFile(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download image from ${url} (status ${response.status}).`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get("content-type");
  return writeTempImageFile(buffer, inferExtensionFromMime(contentType));
}

async function writeTempImageFile(buffer, extension = ".png") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-image-"));
  const safeExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const filePath = path.join(dir, `attachment${safeExtension}`);
  await fs.writeFile(filePath, buffer);
  const cleanup = async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (error) {
      console.warn("Failed to remove temporary image directory:", error);
    }
  };
  return { path: filePath, cleanup };
}

function inferExtensionFromMime(mime) {
  if (!mime) return ".png";
  const normalized = mime.toLowerCase();
  if (normalized.includes("png")) return ".png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  if (normalized.includes("gif")) return ".gif";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("bmp")) return ".bmp";
  return ".png";
}

function collectAttachmentCleanups(messages) {
  const cleanups = [];
  if (!Array.isArray(messages)) return cleanups;
  for (const entry of messages) {
    if (!Array.isArray(entry?.attachments)) continue;
    for (const attachment of entry.attachments) {
      if (typeof attachment?.cleanup === "function") {
        cleanups.push(attachment.cleanup);
      }
    }
  }
  return cleanups;
}

async function cleanupAttachmentFiles(cleanups) {
  if (!Array.isArray(cleanups) || cleanups.length === 0) return;
  await Promise.all(
    cleanups.map(async (cleanup) => {
      try {
        await cleanup();
      } catch (error) {
        console.warn("Failed to cleanup temporary attachment:", error);
      }
    }),
  );
}

async function getOrCreateThread(sessionId, threadOptions) {
  const cached = inMemoryThreads.get(sessionId);
  if (cached) return cached;

  const persistedId = persistedThreadIds.get(sessionId);
  let thread;
  if (persistedId) {
    try {
      thread = codex.resumeThread(persistedId, threadOptions);
      inMemoryThreads.set(sessionId, { thread });
      return { thread };
    } catch (error) {
      console.warn(
        `Failed to resume thread ${persistedId} for session ${sessionId}:`,
        error?.message ?? error,
      );
    }
  }

  thread = codex.startThread(threadOptions);
  inMemoryThreads.set(sessionId, { thread });
  return { thread };
}

async function persistThreadIdIfNeeded(sessionId, thread) {
  if (!thread?.id) return;
  if (persistedThreadIds.get(sessionId) === thread.id) return;
  persistedThreadIds.set(sessionId, thread.id);
  await saveQueue(async () => saveState(persistedThreadIds));
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Object.entries(parsed.sessions ?? {});
    return new Map(entries);
  } catch {
    return new Map();
  }
}

async function saveState(map) {
  const payload = {
    sessions: Object.fromEntries(map.entries()),
  };
  await fs.writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
}

function createSaveQueue() {
  let last = Promise.resolve();
  return (task) => {
    last = last.then(() => task()).catch((err) => {
      console.error("Failed to persist thread IDs:", err);
    });
    return last;
  };
}

function formatUsage(raw) {
  if (!raw) return undefined;
  const prompt = raw.input_tokens ?? 0;
  const completion = raw.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

function extractAssistantResponse(turn) {
  if (turn?.finalResponse) return turn.finalResponse;
  if (turn?.text) return turn.text;
  const agentMessage = turn?.items?.find(
    (item) => item?.type === "agent_message" && item?.text,
  );
  return agentMessage?.text ?? "";
}

function extractAgentMessageText(event) {
  const item = event?.item;
  if (!item) return null;
  if (item.type === "agent_message" && typeof item.text === "string") {
    return item.text;
  }
  return null;
}

async function handleStreamResponse({
  res,
  thread,
  threadOptions,
  sessionId,
  prompt,
  shouldPersist = true,
  turnOptions = {},
  cleanupTasks = [],
}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const created = Math.floor(Date.now() / 1000);
  const chunkId = `chatcmpl-${thread.id ?? crypto.randomUUID()}`;
  const chunkBase = {
    id: chunkId,
    object: "chat.completion.chunk",
    created,
    model: threadOptions.model,
  };
  const sendChunk = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const sendDone = () => {
    res.write("data: [DONE]\n\n");
  };

  const sendDelta = (delta, finishReason = null, usage = null, extra = {}) => {
    const chunk = {
      ...chunkBase,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
      ...extra,
    };
    if (usage) chunk.usage = usage;
    sendChunk(chunk);
  };

  try {
    const streamed = await thread.runStreamed(prompt, turnOptions);
    let bufferedText = "";
    let roleSent = false;
    let usage = undefined;

    for await (const event of streamed.events) {
      if (event?.type === "turn.completed") {
        usage = formatUsage(event?.usage);
        continue;
      }
      if (event?.type === "turn.failed") {
        throw new Error(event?.error?.message ?? "Codex turn failed.");
      }

      const text = extractAgentMessageText(event);
      if (typeof text === "string") {
        if (!roleSent) {
          sendDelta({ role: "assistant" });
          roleSent = true;
        }
        if (text.length > bufferedText.length) {
          const deltaContent = text.slice(bufferedText.length);
          bufferedText = text;
          sendDelta({ content: deltaContent });
        }
      }
    }

    if (shouldPersist) {
      await persistThreadIdIfNeeded(sessionId, thread);
    }
    sendDelta({}, "stop", usage);
    sendDone();
    res.end();
  } catch (error) {
    console.error("Codex stream failed:", error);
    sendChunk({
      ...chunkBase,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "error",
        },
      ],
      error: {
        message: error?.message ?? "Codex streaming failed.",
        type: "codex_stream_error",
      },
    });
    sendDone();
    res.end();
  } finally {
    await cleanupAttachmentFiles(cleanupTasks);
  }
}
