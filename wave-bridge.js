#!/usr/bin/env node
import "dotenv/config";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import express from "express";

const PORT = Number(process.env.PORT ?? 8080);
const API_KEY = process.env.CODEX_BRIDGE_API_KEY ?? "";
const DEFAULT_MODEL = process.env.CODEX_MODEL ?? "gpt-5-codex";
const DEFAULT_REASONING = process.env.CODEX_REASONING ?? "high";
const DEFAULT_CWD = process.env.CODEX_WORKDIR || process.cwd();
const LOG_REQUESTS = /^(1|true|yes)$/i.test(process.env.CODEX_LOG_REQUESTS ?? "");

const app = express();
app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!API_KEY) return next();
  const authHeader = req.get("authorization") ?? "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : req.get("x-api-key");
  if (bearer !== API_KEY) {
    return res.status(401).json({
      error: {
        type: "unauthorized",
        message: "Invalid or missing API key.",
      },
    });
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/v1/models", (_req, res) => {
  const ids = [
    "gpt-5-codex:low",
    "gpt-5-codex:medium",
    "gpt-5-codex:high",
    "gpt-5.4",
  ];
  res.json({
    object: "list",
    data: ids.map((id) => ({ object: "model", id })),
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  const { messages, stream } = req.body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        type: "invalid_request_error",
        message: "Request body must include a non-empty messages array.",
      },
    });
  }

  const requestedModel = typeof req.body?.model === "string" && req.body.model
    ? req.body.model
    : `${DEFAULT_MODEL}:${DEFAULT_REASONING}`;
  const { model, reasoning } = parseModel(requestedModel);
  const prompt = flattenMessages(messages);

  if (LOG_REQUESTS) {
    console.log(
      JSON.stringify(
        {
          at: new Date().toISOString(),
          model,
          reasoning,
          stream: Boolean(stream),
          message_count: messages.length,
        },
        null,
        2,
      ),
    );
  }

  try {
    const result = await runCodex(prompt, { model, reasoning });
    if (stream) {
      return sendStreamResponse(res, result.text, requestedModel);
    }
    return res.json(buildChatResponse(result.text, requestedModel));
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: {
        type: "server_error",
        message: error.message || "Codex bridge failed.",
      },
    });
  }
});

app.listen(PORT, () => {
  console.log(`Wave Codex bridge listening on http://localhost:${PORT}`);
});

function parseModel(value) {
  const [base, suffix] = value.split(":");
  const reasoning = suffix || DEFAULT_REASONING;
  return { model: base || DEFAULT_MODEL, reasoning };
}

function flattenMessages(messages) {
  return messages
    .map((message) => {
      const role = String(message?.role ?? "user").toUpperCase();
      const content = normalizeContent(message?.content);
      return `[${role}]\n${content}`.trim();
    })
    .join("\n\n");
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text ?? "";
      if (part?.type === "input_text") return part.text ?? "";
      if (part?.type === "image_url") return "[image omitted]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function runCodex(prompt, { model, reasoning }) {
  return new Promise((resolve, reject) => {
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      model,
      prompt,
    ];

    const child = spawn("codex", args, {
      cwd: DEFAULT_CWD,
      env: process.env,
    });
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(`codex exec failed with code ${code}\n${stderr || stdout}`.trim()),
        );
      }
      const text = extractAssistantText(stdout);
      return resolve({ text, stdout, stderr });
    });
  });
}

function extractAssistantText(stdout) {
  let finalText = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "item.completed" && event?.item?.type === "agent_message") {
        finalText = event.item.text ?? finalText;
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return finalText || "No response returned.";
}

function buildChatResponse(text, model) {
  const completionTokens = Math.max(1, Math.ceil(text.length / 4));
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: text,
        },
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: completionTokens,
      total_tokens: completionTokens,
    },
  };
}

function sendStreamResponse(res, text, model) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  res.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}
