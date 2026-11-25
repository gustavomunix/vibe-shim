import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** OpenAI-style chat message, tolerant of content being string or parts. */
export interface ChatMessage {
  role: string;
  content: string | Array<Record<string, unknown>> | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  name?: string;
  [key: string]: unknown;
}

export interface OpenAITool {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: string | Record<string, unknown>;
  [key: string]: unknown;
}

export function contentToText(content: ChatMessage["content"]): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  const parts: string[] = [];
  for (const part of content as any[]) {
    if (typeof part === "string") parts.push(part);
    else if (part && part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (part && part.type === "image_url") parts.push("[image attached]");
    else if (part && part.type === "file") parts.push("[file attached]");
  }
  return parts.join("\n");
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
    const text = contentToText(m.content).trim();
    if (!text) continue;
    if (m.role === "system" || m.role === "developer") {
      system.push(text);
    } else if (m.role === "tool") {
      convo.push(`<tool_result>\n${text}\n</tool_result>`);
    } else {
      const tag = m.role === "assistant" ? "assistant" : "user";
      convo.push(`<${tag}>\n${text}\n</${tag}>`);
    }
  }
  if (system.length) {
    sections.push(
      "<system_instructions>\n" + system.join("\n\n") + "\n</system_instructions>",
    );
  }
  sections.push(...convo);
  if (!sections.length) return "Hello.";
  const last = messages[messages.length - 1];
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
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
  };
}
