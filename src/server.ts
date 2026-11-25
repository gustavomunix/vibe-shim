import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { VibeRunServer, RunEndedParams } from "./runserver";
import {
  AgentSocketServer,
  AgentToolDefinition,
  PendingToolCall,
} from "./agentsocket";
import { discoverModels, VibeModel } from "./models";
import {
  ChatCompletionRequest,
  ChatMessage,
  OpenAITool,
  OpenAIToolCall,
  computePrompt,
  contentToText,
  readRunResult,
  completionToJson,
  toolCallsToJson,
} from "./translate";

export interface ServerOptions {
  port: number;
  workspace: string;
  stateDir: string;
  runsDir: string;
  log: (line: string) => void;
}

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const PARKED_TTL_MS = 30 * 60 * 1000;
const TOOL_BATCH_WINDOW_MS = 200;

interface ToolMapping {
  definitions: AgentToolDefinition[];
  reverseNames: Map<string, string>; // sanitized name -> original OpenAI tool name
}

function sanitizeToolName(name: string): string {
  let clean = name.replace(/[^A-Za-z0-9_$]/g, "_");
  if (!clean) clean = "_";
  if (/^[0-9]/.test(clean)) clean = `_${clean}`;
  return clean;
}

function normalizeParameters(params: unknown): Record<string, unknown> {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const obj = params as Record<string, unknown>;
    if (Object.keys(obj).length > 0) return obj;
  }
  return { type: "object", properties: {} };
}

function mapOpenAITools(tools: OpenAITool[] | undefined, toolChoice: unknown): ToolMapping {
  const definitions: AgentToolDefinition[] = [];
  const reverseNames = new Map<string, string>();
  if (!Array.isArray(tools) || tools.length === 0 || toolChoice === "none") {
    return { definitions, reverseNames };
  }
  const used = new Set<string>();
  for (const t of tools) {
    if (t?.type && t.type !== "function") continue;
    const origName = t?.function?.name;
    if (!origName || typeof origName !== "string") continue;
    const base = sanitizeToolName(origName);
    let safeName = base;
    let suffix = 2;
    while (used.has(safeName)) {
      safeName = `${base}_${suffix++}`;
    }
    used.add(safeName);
    reverseNames.set(safeName, origName);
    definitions.push({
      namespace: "client",
      name: safeName,
      description: typeof t.function?.description === "string" ? t.function.description : "",
      inputSchema: normalizeParameters(t.function?.parameters),
      modelAccess: "direct",
    });
  }
  return { definitions, reverseNames };
}

function stripNamespace(name: string): string {
  return name.startsWith("client.") ? name.slice("client.".length) : name;
}

function parseToolResultOutput(content: ChatMessage["content"]): unknown {
  const text = contentToText(content);
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* keep raw text */
    }
  }
  return text;
}

function trailingToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "tool" && typeof m.tool_call_id === "string" && m.tool_call_id) {
      out.push(m);
    } else {
      break;
    }
  }
  return out.reverse();
}

interface ParkedRun {
  runId: string;
  outputDir: string;
  socket: AgentSocketServer;
  endedPromise: Promise<RunEndedParams>;
  pendingCalls: Map<string, PendingToolCall>;
  reverseNames: Map<string, string>;
  model: string;
  createdAt: number;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  cleanedUp: boolean;
  // Batch queue for arriving tools/call requests while waiting on a segment
  incomingQueue: PendingToolCall[];
  onIncoming: (() => void) | null;
}

type SegmentResult =
  | { kind: "tool_calls"; calls: PendingToolCall[] }
  | { kind: "ended"; ended: RunEndedParams };

export function createShimServer(
  runServer: VibeRunServer,
  opts: ServerOptions,
): http.Server {
  let catalog: VibeModel[] = [];
  try {
    catalog = discoverModels();
    opts.log(`catálogo descoberto: ${catalog.map((m) => m.alias).join(", ")}`);
  } catch (err: any) {
    opts.log(`falha ao descobrir catálogo: ${err.message}`);
  }
  const defaultAlias = catalog[0]?.alias;

  const parkedByToolId = new Map<string, ParkedRun>();
  const activeRuns = new Set<ParkedRun>();

  function clearTtl(run: ParkedRun): void {
    if (run.ttlTimer) {
      clearTimeout(run.ttlTimer);
      run.ttlTimer = null;
    }
  }

  function unindexRun(run: ParkedRun): void {
    for (const [id, r] of parkedByToolId) {
      if (r === run) parkedByToolId.delete(id);
    }
  }

  function failAllPending(run: ParkedRun, message: string): void {
    for (const call of run.pendingCalls.values()) {
      call.reply({ error: { message } });
    }
    run.pendingCalls.clear();
    for (const call of run.incomingQueue) {
      call.reply({ error: { message } });
    }
    run.incomingQueue = [];
  }

  async function abortRun(run: ParkedRun, reason: string): Promise<void> {
    if (run.cleanedUp) return;
    run.cleanedUp = true;
    clearTtl(run);
    unindexRun(run);
    activeRuns.delete(run);
    failAllPending(run, reason);
    await runServer.stopRun(run.runId);
    await run.socket.close();
  }

  async function finishRun(run: ParkedRun): Promise<void> {
    if (run.cleanedUp) return;
    run.cleanedUp = true;
    clearTtl(run);
    unindexRun(run);
    activeRuns.delete(run);
    failAllPending(run, "run ended");
    await run.socket.close();
  }

  function armTtl(run: ParkedRun): void {
    clearTtl(run);
    run.ttlTimer = setTimeout(() => {
      opts.log(`parked run ${run.runId} expired after TTL`);
      void abortRun(run, "parked run expired");
    }, PARKED_TTL_MS);
    run.ttlTimer.unref?.();
  }

  async function waitForSegment(run: ParkedRun): Promise<SegmentResult> {
    let segmentTimer: ReturnType<typeof setTimeout> | null = null;
    let batchTimer: ReturnType<typeof setTimeout> | null = null;

    const batchPromise = new Promise<SegmentResult>((resolve) => {
      let resolved = false;
      const flush = () => {
        if (resolved) return;
        resolved = true;
        if (batchTimer) {
          clearTimeout(batchTimer);
          batchTimer = null;
        }
        run.onIncoming = null;
        const calls = run.incomingQueue.splice(0);
        resolve({ kind: "tool_calls", calls });
      };
      const schedule = () => {
        if (resolved || batchTimer) return;
        batchTimer = setTimeout(flush, TOOL_BATCH_WINDOW_MS);
      };
      run.onIncoming = schedule;
      if (run.incomingQueue.length > 0) {
        schedule();
      }
    });

    const endedMapped = run.endedPromise.then<SegmentResult>((ended) => ({
      kind: "ended",
      ended,
    }));

    segmentTimer = setTimeout(() => {
      opts.log(`run ${run.runId} segment timed out after ${RUN_TIMEOUT_MS}ms`);
      failAllPending(run, "segment timed out");
      void runServer.stopRun(run.runId);
    }, RUN_TIMEOUT_MS);

    try {
      const winner = await Promise.race([batchPromise, endedMapped]);
      return winner;
    } finally {
      if (segmentTimer) clearTimeout(segmentTimer);
      if (batchTimer) clearTimeout(batchTimer);
      run.onIncoming = null;
    }
  }

  function formatToolCalls(run: ParkedRun, calls: PendingToolCall[]): OpenAIToolCall[] {
    return calls.map((call) => {
      const bare = stripNamespace(call.name);
      const origName = run.reverseNames.get(bare) ?? bare;
      return {
        id: call.toolCallId,
        type: "function",
        function: {
          name: origName,
          arguments: JSON.stringify(call.input ?? {}),
        },
      };
    });
  }

  function findParkedRun(messages: ChatMessage[]): { run: ParkedRun; trailing: ChatMessage[] } | null {
    const trailing = trailingToolMessages(messages);
    if (trailing.length === 0) return null;
    for (const msg of trailing) {
      const hit = parkedByToolId.get(msg.tool_call_id!);
      if (hit && !hit.cleanedUp) {
        return { run: hit, trailing };
      }
    }
    return null;
  }

  async function startNewRun(body: ChatCompletionRequest): Promise<ParkedRun> {
    const prompt = computePrompt(body.messages);
    const runId = randomUUID();
    const outputDir = join(opts.runsDir, runId);
    mkdirSync(outputDir, { recursive: true });

    const { definitions, reverseNames } = mapOpenAITools(body.tools, body.tool_choice);

    const config: Record<string, unknown> = {};
    const knownAliases = new Set(catalog.map((m) => m.alias));
    if (body.model && knownAliases.has(body.model)) {
      config.active_model = body.model;
    } else if (body.model && defaultAlias) {
      opts.log(`modelo "${body.model}" desconhecido; usando default ${defaultAlias}`);
      config.active_model = defaultAlias;
    }

    let runRef: ParkedRun | null = null;
    const socket = new AgentSocketServer({
      workspace: opts.workspace,
      log: (line) => opts.log(`[agent-socket:${runId.slice(0, 8)}] ${line}`),
      tools: definitions,
      onToolCall: (call) => {
        if (!runRef || runRef.cleanedUp) {
          call.reply({ error: { message: "run no longer active" } });
          return;
        }
        opts.log(`tools/call ${call.name} (${call.toolCallId})`);
        runRef.incomingQueue.push(call);
        runRef.onIncoming?.();
      },
    });

    await socket.listen();

    let endedPromise: Promise<RunEndedParams>;
    try {
      const launched = await runServer.launchRun({
        runId,
        prompt,
        agentSocket: socket.socketPath,
        outputDir,
        autoApprove: true,
        enabledTools: [],
        ...(Object.keys(config).length ? { config } : {}),
      });
      endedPromise = launched.ended;
    } catch (err) {
      await socket.close();
      throw err;
    }

    const run: ParkedRun = {
      runId,
      outputDir,
      socket,
      endedPromise,
      pendingCalls: new Map(),
      reverseNames,
      model: body.model || defaultAlias || "vibe",
      createdAt: Date.now(),
      ttlTimer: null,
      cleanedUp: false,
      incomingQueue: [],
      onIncoming: null,
    };
    runRef = run;
    activeRuns.add(run);

    // Ensure socket always closes if run ends unexpectedly while parked.
    void endedPromise.then(
      () => void finishRun(run),
      () => void finishRun(run),
    );

    return run;
  }

  function resumeParkedRun(run: ParkedRun, trailing: ChatMessage[]): void {
    clearTtl(run);
    unindexRun(run);
    const supplied = new Map<string, ChatMessage>();
    for (const msg of trailing) {
      if (msg.tool_call_id) supplied.set(msg.tool_call_id, msg);
    }
    for (const [toolCallId, call] of run.pendingCalls) {
      const msg = supplied.get(toolCallId);
      if (msg) {
        call.reply({ output: parseToolResultOutput(msg.content) });
      } else {
        call.reply({ error: { message: "no result supplied" } });
      }
    }
    run.pendingCalls.clear();
  }

  async function runCompletion(
    body: ChatCompletionRequest,
    res: http.ServerResponse,
  ): Promise<{ completion: Record<string, unknown>; finishReason: "stop" | "tool_calls" }> {
    const match = findParkedRun(body.messages);
    let run: ParkedRun;
    if (match) {
      run = match.run;
      opts.log(`resuming parked run ${run.runId} with ${match.trailing.length} tool result(s)`);
      resumeParkedRun(run, match.trailing);
    } else {
      run = await startNewRun(body);
    }

    let requestFinished = false;
    const onClientClose = () => {
      if (requestFinished) return;
      opts.log(`client disconnected mid-request; stopping run ${run.runId}`);
      void abortRun(run, "client disconnected");
    };
    res.once("close", onClientClose);

    try {
      const segment = await waitForSegment(run);
      if (segment.kind === "tool_calls") {
        const calls = segment.calls;
        for (const call of calls) {
          run.pendingCalls.set(call.toolCallId, call);
          parkedByToolId.set(call.toolCallId, run);
        }
        armTtl(run);
        const formatted = formatToolCalls(run, calls);
        requestFinished = true;
        return {
          completion: toolCallsToJson(body, formatted, run.model),
          finishReason: "tool_calls",
        };
      }

      const ended = segment.ended;
      await finishRun(run);
      requestFinished = true;

      const exportFile = join(run.outputDir, "export.json");
      if (existsSync(exportFile)) {
        try {
          const { text, exportInfo } = readRunResult(run.outputDir);
          return {
            completion: completionToJson(body, text, exportInfo, run.model),
            finishReason: "stop",
          };
        } catch (err: any) {
          opts.log(`export read failed: ${err.message}`);
        }
      }
      const message =
        ended.error?.message ||
        `run ended as ${ended.outcome || "outcome=unknown"}`;
      throw new Error(`vibe run: ${message}`);
    } catch (err) {
      await abortRun(run, err instanceof Error ? err.message : "run failed");
      throw err;
    } finally {
      res.off("close", onClientClose);
    }
  }

  const send = (res: http.ServerResponse, code: number, body: unknown) => {
    const json = JSON.stringify(body);
    res.writeHead(code, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(json),
    });
    res.end(json);
  };

  function writeSseCompletion(
    res: http.ServerResponse,
    completion: Record<string, any>,
    finishReason: "stop" | "tool_calls",
  ): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const chunk = (delta: unknown, finish: string | null) =>
      "data: " +
      JSON.stringify({
        id: completion.id,
        object: "chat.completion.chunk",
        created: completion.created,
        model: completion.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) +
      "\n\n";
    res.write(chunk({ role: "assistant" }, null));
    const message = completion.choices[0].message;
    if (finishReason === "tool_calls" && Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach((tc: OpenAIToolCall, index: number) => {
        res.write(
          chunk(
            {
              tool_calls: [
                {
                  index,
                  id: tc.id,
                  type: tc.type,
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                },
              ],
            },
            null,
          ),
        );
      });
      res.write(chunk({}, "tool_calls"));
    } else {
      res.write(chunk({ content: message.content }, null));
      res.write(chunk({}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  }

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, {
        status: "ok",
        provider: "vibe-shim",
        engine: "mistral-vibe (programmatic mode)",
      });
    }
    if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
      return send(res, 200, {
        object: "list",
        data: catalog.map((m) => ({
          id: m.alias,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "vibe-shim",
        })),
      });
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) {
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("error", () => res.destroy());
      req.on("end", async () => {
        let body: ChatCompletionRequest;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!Array.isArray(body.messages)) throw new Error("field messages missing");
        } catch (err: any) {
          return send(res, 400, { error: { message: `invalid request: ${err.message}` } });
        }
        try {
          const { completion, finishReason } = await runCompletion(body, res);
          if (res.writableEnded || res.destroyed) return;
          if (body.stream) {
            writeSseCompletion(res, completion, finishReason);
          } else {
            send(res, 200, completion);
          }
        } catch (err: any) {
          opts.log(`completion failed: ${err.message}`);
          if (!res.headersSent && !res.destroyed) {
            send(res, 502, { error: { message: err.message, type: "upstream_error" } });
          }
        }
      });
      return;
    }
    send(res, 404, { error: { message: `no route ${req.method} ${req.url}` } });
  });

  server.on("close", () => {
    for (const run of [...activeRuns]) {
      void abortRun(run, "server shutting down");
    }
  });

  return server;
}
