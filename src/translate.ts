import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** OpenAI-style chat message, tolerant of content being string or parts. */
export interface ChatMessage {
  role: string;
  content?: string | Array<Record<string, unknown>> | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: unknown };
  }>;
  function_call?: { name?: string; arguments?: unknown };
  name?: string;
  [key: string]: unknown;
}

export interface OpenAITool {
  type?: string;
  name?: string;
  description?: string;
  parameters?: unknown;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface LegacyOpenAIFunction {
  name?: string;
  description?: string;
  parameters?: unknown;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: OpenAITool[];
  functions?: LegacyOpenAIFunction[];
  tool_choice?: string | Record<string, unknown>;
  function_call?: string | Record<string, unknown>;
  [key: string]: unknown;
}

export function contentToText(content: ChatMessage["content"]): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (typeof content === "object") {
      try {
        return JSON.stringify(content);
      } catch {
        return String(content);
      }
    }
    return String(content);
  }
  const parts: string[] = [];
  for (const part of content as any[]) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (part && typeof part === "object") {
      if (part.type === "text" && typeof part.text === "string") {
        parts.push(part.text);
      } else if (typeof part.text === "string") {
        parts.push(part.text);
      } else if (part.type === "image_url") {
        parts.push("[image attached]");
      } else if (part.type === "file") {
        parts.push("[file attached]");
      } else if (typeof part.content === "string") {
        parts.push(part.content);
      }
    }
  }
  return parts.join("\n");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatToolCallArgs(args: unknown): string {
  if (args === undefined || args === null) return "{}";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/**
 * Flatten the OpenAI history into the one prompt a vibe run takes. The
 * engine's own harness guidance and project context are added by vibe
 * itself, on top of this text.
 */
export function computePrompt(messages: ChatMessage[]): string {
  const sections: string[] = [];
  const system: string[] = [];
  const convo: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const text = contentToText(m.content).trim();
    if (m.role === "system" || m.role === "developer") {
      if (text) system.push(text);
    } else if (m.role === "tool" || m.role === "function") {
      const attrs: string[] = [];
      if (typeof m.tool_call_id === "string" && m.tool_call_id) {
        attrs.push(`id="${escapeAttr(m.tool_call_id)}"`);
      }
      if (typeof m.name === "string" && m.name) {
        attrs.push(`name="${escapeAttr(m.name)}"`);
      }
      const attrStr = attrs.length ? " " + attrs.join(" ") : "";
      convo.push(`<tool_result${attrStr}>\n${text}\n</tool_result>`);
    } else if (m.role === "assistant") {
      const pieces: string[] = [];
      if (text) pieces.push(text);
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc || typeof tc !== "object") continue;
          const fnName = typeof tc.function?.name === "string" ? tc.function.name : "";
          const tcId = typeof tc.id === "string" ? tc.id : "";
          const attrs: string[] = [];
          if (tcId) attrs.push(`id="${escapeAttr(tcId)}"`);
          if (fnName) attrs.push(`name="${escapeAttr(fnName)}"`);
          const attrStr = attrs.length ? " " + attrs.join(" ") : "";
          const args = formatToolCallArgs(tc.function?.arguments);
          pieces.push(`<tool_call${attrStr}>${args}</tool_call>`);
        }
      } else if (m.function_call && typeof m.function_call === "object") {
        const fnName = typeof m.function_call.name === "string" ? m.function_call.name : "";
        const attrStr = fnName ? ` name="${escapeAttr(fnName)}"` : "";
        const args = formatToolCallArgs(m.function_call.arguments);
        pieces.push(`<tool_call${attrStr}>${args}</tool_call>`);
      }
      if (pieces.length) {
        convo.push(`<assistant>\n${pieces.join("\n")}\n</assistant>`);
      }
    } else {
      if (text) {
        convo.push(`<user>\n${text}\n</user>`);
      }
    }
  }
  if (system.length) {
    sections.push(
      "<system_instructions>\n" + system.join("\n\n") + "\n</system_instructions>",
    );
  }
  sections.push(...convo);
  if (!sections.length) return "Hello.";
  return sections.join("\n\n");
}

interface ExportUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  total_tokens?: number;
}

interface RunExport {
  outcome: string;
  session_id?: string | null;
  usage?: ExportUsage | null;
  cost_usd?: number | null;
  journal_dir?: string | null;
}

interface JournalMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }> | string;
  source?: string;
}

export interface CompletionResult {
  text: string;
  exportInfo: RunExport;
}

/**
 * Read the run's export directory: export.json plus the copied session
 * journal (messages.jsonl) under the journal dir. The reply is the last
 * assistant message the run produced.
 */
export function readRunResult(outputDir: string): CompletionResult {
  const exportPath = join(outputDir, "export.json");
  if (!existsSync(exportPath)) {
    throw new Error("run finished without an export (no export.json)");
  }
  const exportInfo = JSON.parse(readFileSync(exportPath, "utf8")) as RunExport;
  const sessionDir = join(outputDir, exportInfo.journal_dir || "session");

  // The reply lives in the last generation checkpoint that holds a terminal
  // turn outcome: turn.outcome.output is the model's final message.
  const generationsDir = join(sessionDir, "generations");
  let text = "";
  if (existsSync(generationsDir)) {
    const entries = readdirSync(generationsDir)
      .filter((e) => /^\d+$/.test(e))
      .sort()
      .reverse();
    for (const gen of entries) {
      const checkpointPath = join(generationsDir, gen, "checkpoint.json");
      if (!existsSync(checkpointPath)) continue;
      let checkpoint: any;
      try {
        checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
      } catch {
        continue;
      }
      const output = checkpoint?.turn?.outcome?.output;
      if (Array.isArray(output)) {
        const t = output
          .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text as string)
          .join("");
        if (t.trim()) {
          text = t;
          break;
        }
      }
    }
  }
  if (!text) {
    throw new Error("run journal has no assistant output");
  }
  return { text, exportInfo };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export function toolCallsToJson(
  req: ChatCompletionRequest,
  toolCalls: OpenAIToolCall[],
  sessionModel: string | null,
): Record<string, unknown> {
  return {
    id: "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: req.model || sessionModel || "vibe",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, tool_calls: toolCalls },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function completionToJson(
  req: ChatCompletionRequest,
  text: string,
  exportInfo: RunExport,
  sessionModel: string | null,
): Record<string, unknown> {
  const usage = exportInfo.usage || {};
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  return {
    id: "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: req.model || sessionModel || "vibe",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      ...(typeof usage.cached_input_tokens === "number"
        ? { prompt_tokens_details: { cached_tokens: usage.cached_input_tokens } }
        : {}),
    },
  };
}
