import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
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
  LegacyOpenAIFunction,
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
  batchWindowMs?: number;
  catalog?: VibeModel[];
}

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const PARKED_TTL_MS = 30 * 60 * 1000;
const DEFAULT_TOOL_BATCH_WINDOW_MS = 200;
const STALE_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_TOOL_NAME_LEN = 64;

export interface ToolMapping {
  definitions: AgentToolDefinition[];
  reverseNames: Map<string, string>; // sanitized name -> original OpenAI tool name
}

// Direct names the engine refuses for caller tools ("conflicts with a built-in
// tool"). The engine's list depends on its config, so names it rejects at run
// time are learned and renamed on the retry.
const reservedToolNames = new Set([
  "bash", "edit", "read", "write", "read_file", "write_file", "search_replace",
  "grep", "glob", "ls", "skill", "sleep", "wait", "task", "todo", "web_fetch",
  "web_search", "ask_user_question", "sign_in",
  "run_typescript", "search_tool_functions", "list_processes", "read_process_output",
  "stop_process", "send_process_input",
]);
const CONFLICT_RE = /direct tool name "([^"]+)" conflicts with a built-in tool/;

export // The engine's own tools are always disabled here, so what only exists to
// describe them (subagents, background processes, MCP, connectors, workspace
// AGENTS.md) just costs prompt tokens (~11% measured).
const LEAN_RUN_CONFIG: Record<string, unknown> = {
  enable_background_processes: false,
  enable_subagents: false,
  enable_mcp: false,
  enable_connectors: false,
  include_project_context: false,
};

// VIBE_SHIM_RUN_CONFIG: JSON object merged over LEAN_RUN_CONFIG into every
// run's `config` (the config.toml document as JSON), e.g. to restore a default:
// {"enable_subagents":true}.
let cachedRunConfig: Record<string, unknown> | undefined;
function extraRunConfig(): Record<string, unknown> {
  if (cachedRunConfig) return cachedRunConfig;
  const raw = process.env.VIBE_SHIM_RUN_CONFIG;
  let parsed: unknown = {};
  if (raw && raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`VIBE_SHIM_RUN_CONFIG is not valid JSON: ${err.message}`);
    }
  }
  const overrides =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  cachedRunConfig = { ...LEAN_RUN_CONFIG, ...overrides };
  return cachedRunConfig;
}

function sanitizeToolName(name: string): string {
  let clean = name.replace(/[^A-Za-z0-9_$]/g, "_");
  if (!clean) clean = "_";
  if (/^[0-9]/.test(clean)) clean = `_${clean}`;
  if (clean.length > MAX_TOOL_NAME_LEN) {
    const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
    clean = `${clean.slice(0, MAX_TOOL_NAME_LEN - 9)}_${hash}`;
  }
  return clean;
}

function resolveJsonPointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith("#")) return undefined;
  const path = pointer.slice(1);
  if (!path) return root;
  if (!path.startsWith("/")) return undefined;
  let cur: unknown = root;
  for (const seg of path.slice(1).split("/")) {
    const key = seg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur && typeof cur === "object" && !Array.isArray(cur) && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

function topLevelSchemaTypes(
  root: unknown,
  node: unknown,
  reading: Set<string>,
  depth: number,
): string[] | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string") {
    const ref = obj.$ref;
    if (!ref.startsWith("#") || reading.has(ref) || depth >= 32) return null;
    const target = resolveJsonPointer(root, ref);
    if (target === undefined) return null;
    reading.add(ref);
    const res = topLevelSchemaTypes(root, target, reading, depth + 1);
    reading.delete(ref);
    return res;
  }

  let types: string[] | null = null;
  if (typeof obj.type === "string") {
    types = [obj.type];
  } else if (Array.isArray(obj.type) && obj.type.length > 0) {
    types = obj.type.map((t) => (typeof t === "string" ? t : ""));
  }

  for (const kw of ["anyOf", "oneOf"] as const) {
    const branches = obj[kw];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const union: string[] = [];
    let allTyped = true;
    for (const branch of branches) {
      const found = topLevelSchemaTypes(root, branch, reading, depth + 1);
      if (!found) {
        allTyped = false;
        break;
      }
      union.push(...found);
    }
    if (!allTyped) continue;
    if (types) {
      types = types.filter((t) => union.includes(t));
    } else {
      types = union;
    }
  }

  if (!types) return null;
  return Array.from(new Set(types)).sort();
}

export function normalizeParameters(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { type: "object", properties: {} };
  }
  const obj = params as Record<string, unknown>;
  if (Object.keys(obj).length === 0) {
    return { type: "object", properties: {} };
  }

  // Handle nullable/multi-type top-level object like type: ["object", "null"]
  if (Array.isArray(obj.type)) {
    const copy: Record<string, unknown> = { ...obj };
    if (copy.type && Array.isArray(copy.type) && copy.type.includes("object")) {
      copy.type = "object";
      if (!copy.properties || typeof copy.properties !== "object") {
        copy.properties = {};
      }
      return normalizeParameters(copy);
    }
  }

  // Resolve top-level $ref if it points to a local object schema; otherwise wrap/fallback.
  if (typeof obj.$ref === "string") {
    const resolved = resolveJsonPointer(obj, obj.$ref);
    if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
      const defs: Record<string, unknown> = {};
      if (obj.$defs && typeof obj.$defs === "object") defs.$defs = obj.$defs;
      if (obj.definitions && typeof obj.definitions === "object") defs.definitions = obj.definitions;
      const merged = { ...(resolved as Record<string, unknown>), ...defs };
      const types = topLevelSchemaTypes(merged, merged, new Set(["#"]), 0);
      if (types && types.length === 1 && types[0] === "object") {
        return merged;
      }
    }
    return { type: "object", properties: { value: obj } };
  }

  // Check if the engine's top-level object check would reject this schema.
  const types = topLevelSchemaTypes(obj, obj, new Set(["#"]), 0);
  if (types === null) {
    // Untyped schema (e.g. only properties or anyOf with untyped branch): force type: object
    // while keeping properties if present; drop top-level anyOf/oneOf that might confuse providers.
    const hasProps = obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties);
    if (hasProps && !obj.anyOf && !obj.oneOf) {
      return { ...obj, type: "object" };
    }
    if (obj.anyOf || obj.oneOf) {
      return { type: "object", properties: { value: obj } };
    }
    return { type: "object", properties: {}, ...obj };
  }
  if (types.length === 1 && types[0] === "object") {
    if (obj.type === "object" && !obj.anyOf && !obj.oneOf) return obj;
    if (obj.anyOf || obj.oneOf) {
      const branches = (obj.anyOf ?? obj.oneOf) as unknown[];
      const mergedProps: Record<string, unknown> = {};
      for (const b of branches) {
        if (b && typeof b === "object" && !Array.isArray(b)) {
          const bp = (b as Record<string, unknown>).properties;
          if (bp && typeof bp === "object" && !Array.isArray(bp)) {
            Object.assign(mergedProps, bp);
          }
        }
      }
      const { anyOf: _a, oneOf: _o, ...rest } = obj;
      const existingProps =
        rest.properties && typeof rest.properties === "object" && !Array.isArray(rest.properties)
          ? (rest.properties as Record<string, unknown>)
          : {};
      return { ...rest, type: "object", properties: { ...mergedProps, ...existingProps } };
    }
    return { ...obj, type: "object" };
  }

  // Top-level type is not solely "object" (e.g. "string", "array", ["string","null"], anyOf string|object).
  // Wrap as an object schema so the engine never rejects the run.
  return {
    type: "object",
    properties: { value: obj },
  };
}

function resolveToolChoice(
  toolChoice: unknown,
  functionCall: unknown,
): { mode: "none" | "auto" | "required" | "named"; name?: string } {
  const raw = toolChoice !== undefined ? toolChoice : functionCall;
  if (raw === "none") return { mode: "none" };
  if (raw === "required") return { mode: "required" };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (obj.type === "function" && obj.function && typeof obj.function === "object") {
      const name = (obj.function as Record<string, unknown>).name;
      if (typeof name === "string" && name) return { mode: "named", name };
    }
    if (typeof obj.name === "string" && obj.name) {
      return { mode: "named", name: obj.name };
    }
  }
  return { mode: "auto" };
}

export function mapOpenAITools(
  tools: OpenAITool[] | undefined,
  toolChoice: unknown,
  functions?: LegacyOpenAIFunction[],
  functionCall?: unknown,
): ToolMapping {
  const definitions: AgentToolDefinition[] = [];
  const reverseNames = new Map<string, string>();
  const choice = resolveToolChoice(toolChoice, functionCall);
  if (choice.mode === "none") {
    return { definitions, reverseNames };
  }

  const normalized: Array<{ name: string; description: string; parameters: unknown }> = [];
  if (Array.isArray(tools) && tools.length > 0) {
    for (const t of tools) {
      if (!t || typeof t !== "object") continue;
      if (t.type && t.type !== "function") continue;
      const fn = t.function && typeof t.function === "object" ? t.function : t;
      const origName = fn?.name;
      if (!origName || typeof origName !== "string") continue;
      normalized.push({
        name: origName,
        description: typeof fn.description === "string" ? fn.description : "",
        parameters: fn.parameters,
      });
    }
  } else if (Array.isArray(functions) && functions.length > 0) {
    for (const f of functions) {
      if (!f || typeof f !== "object") continue;
      if (!f.name || typeof f.name !== "string") continue;
      normalized.push({
        name: f.name,
        description: typeof f.description === "string" ? f.description : "",
        parameters: f.parameters,
      });
    }
  }

  if (normalized.length === 0) {
    return { definitions, reverseNames };
  }

  const used = new Set<string>();
  for (const item of normalized) {
    let base = sanitizeToolName(item.name);
    if (reservedToolNames.has(base)) {
      base = `client_${base}`;
      if (base.length > MAX_TOOL_NAME_LEN) {
        const hash = createHash("sha256").update(item.name).digest("hex").slice(0, 8);
        base = `${base.slice(0, MAX_TOOL_NAME_LEN - 9)}_${hash}`;
      }
    }
    let safeName = base;
    let suffix = 2;
    while (used.has(safeName) || reservedToolNames.has(safeName)) {
      const s = `_${suffix++}`;
      safeName = `${base.slice(0, MAX_TOOL_NAME_LEN - s.length)}${s}`;
    }
    used.add(safeName);
    reverseNames.set(safeName, item.name);
    definitions.push({
      namespace: "client",
      name: safeName,
      description: item.description,
      inputSchema: normalizeParameters(item.parameters),
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

function shouldKeepRuns(): boolean {
  return process.env.VIBE_SHIM_KEEP_RUNS === "1";
}

function cleanupRunDir(dir: string): void {
  if (shouldKeepRuns()) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export function sweepStaleRuns(runsDir: string, log?: (line: string) => void): void {
  if (shouldKeepRuns() || !existsSync(runsDir)) return;
  const cutoff = Date.now() - STALE_RUN_MAX_AGE_MS;
  let removed = 0;
  try {
    for (const entry of readdirSync(runsDir)) {
      const full = join(runsDir, entry);
      try {
        const st = statSync(full);
        if (st.mtimeMs < cutoff) {
          rmSync(full, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* ignore individual entry errors */
      }
    }
  } catch {
    /* ignore */
  }
  if (removed > 0) {
    log?.(`swept ${removed} stale run dir(s) from ${runsDir}`);
  }
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
  inFlight: boolean;
  // Batch queue for arriving tools/call requests while waiting on a segment
  // or while the run is parked awaiting tool results.
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
  const batchWindowMs = opts.batchWindowMs ?? DEFAULT_TOOL_BATCH_WINDOW_MS;
  sweepStaleRuns(opts.runsDir, opts.log);

  let catalog: VibeModel[] = [];
  if (opts.catalog) {
    catalog = opts.catalog;
  } else {
    try {
      catalog = discoverModels();
      opts.log(`catálogo descoberto: ${catalog.map((m) => m.alias).join(", ")}`);
    } catch (err: any) {
      opts.log(`falha ao descobrir catálogo: ${err.message}`);
    }
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
    run.inFlight = false;
    clearTtl(run);
    unindexRun(run);
    activeRuns.delete(run);
    failAllPending(run, reason);
    await runServer.stopRun(run.runId);
    await run.socket.close();
    cleanupRunDir(run.outputDir);
  }

  async function finishRun(run: ParkedRun, removeDir = true): Promise<void> {
    if (run.cleanedUp) return;
    run.cleanedUp = true;
    run.inFlight = false;
    clearTtl(run);
    unindexRun(run);
    activeRuns.delete(run);
    failAllPending(run, "run ended");
    await run.socket.close();
    if (removeDir) cleanupRunDir(run.outputDir);
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
        batchTimer = setTimeout(flush, batchWindowMs);
      };
      run.onIncoming = schedule;
      if (run.incomingQueue.length > 0) {
        // Calls that arrived while the run was parked are already waiting;
        // wait briefly in case sibling calls arrive in the same burst, then
        // deliver them as the next batch.
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
      if (hit && !hit.cleanedUp && !hit.inFlight) {
        return { run: hit, trailing };
      }
    }
    return null;
  }

  function hasInFlightToolIds(messages: ChatMessage[]): boolean {
    const trailing = trailingToolMessages(messages);
    for (const msg of trailing) {
      const hit = parkedByToolId.get(msg.tool_call_id!);
      if (hit && !hit.cleanedUp && hit.inFlight) return true;
    }
    return false;
  }

  async function startNewRun(body: ChatCompletionRequest): Promise<ParkedRun> {
    const prompt = computePrompt(body.messages);
    const runId = randomUUID();
    const outputDir = join(opts.runsDir, runId);
    mkdirSync(outputDir, { recursive: true });

    const { definitions, reverseNames } = mapOpenAITools(
      body.tools,
      body.tool_choice,
      body.functions,
      body.function_call,
    );
    const choice = resolveToolChoice(body.tool_choice, body.function_call);
    if (choice.mode === "required" || choice.mode === "named") {
      opts.log(
        `tool_choice=${choice.mode}${choice.name ? `(${choice.name})` : ""} is not enforced by vibe engine; proceeding with all declared tools`,
      );
    }

    const config: Record<string, unknown> = { ...extraRunConfig() };
    const knownAliases = new Set(catalog.map((m) => m.alias));
    if (body.model && knownAliases.has(body.model)) {
      config.active_model = body.model;
    } else if (body.model && defaultAlias) {
      opts.log(`modelo "${body.model}" desconhecido; usando default ${defaultAlias}`);
      config.active_model = defaultAlias;
    }

    const earlyQueue: PendingToolCall[] = [];
    let runRef: ParkedRun | null = null;
    const socket = new AgentSocketServer({
      workspace: opts.workspace,
      log: (line) => opts.log(`[agent-socket:${runId.slice(0, 8)}] ${line}`),
      tools: definitions,
      onToolCall: (call) => {
        const bare = stripNamespace(call.name);
        if (!reverseNames.has(bare)) {
          opts.log(`tools/call for undeclared tool ${call.name} (${call.toolCallId}); returning error`);
          call.reply({
            error: {
              message: `vibe-shim: undeclared tool "${call.name}"`,
              code: "undeclared_tool",
            },
          });
          return;
        }
        if (!runRef) {
          opts.log(`tools/call ${call.name} (${call.toolCallId}) queued before launchRun resolved`);
          earlyQueue.push(call);
          return;
        }
        if (runRef.cleanedUp) {
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
        // An empty list means "no filter" in the engine; a pattern that matches
        // nothing is what actually switches its own tools off.
        enabledTools: ["__vibe_shim_none__"],
        ...(Object.keys(config).length ? { config } : {}),
      });
      endedPromise = launched.ended;
    } catch (err) {
      for (const call of earlyQueue) {
        call.reply({ error: { message: "run failed to start" } });
      }
      await socket.close();
      cleanupRunDir(outputDir);
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
      inFlight: true,
      incomingQueue: earlyQueue,
      onIncoming: null,
    };
    runRef = run;
    activeRuns.add(run);

    // Ensure socket always closes if run ends unexpectedly while parked.
    // While inFlight, runCompletion reads export.json before deleting outputDir.
    void endedPromise.then(
      () => {
        if (!run.inFlight) void finishRun(run, true);
      },
      () => {
        if (!run.inFlight) void finishRun(run, true);
      },
    );

    return run;
  }

  function resumeParkedRun(run: ParkedRun, trailing: ChatMessage[]): void {
    run.inFlight = true;
    clearTtl(run);
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
    if (!match && hasInFlightToolIds(body.messages)) {
      const err: any = new Error("duplicate request: tool call batch is already in flight");
      err.statusCode = 409;
      throw err;
    }
    let run: ParkedRun;
    if (match) {
      run = match.run;
      opts.log(`resuming parked run ${run.runId} with ${match.trailing.length} tool result(s)`);
      resumeParkedRun(run, match.trailing);
    } else {
      run = await startNewRun(body);
    }

    if (res.destroyed || res.writableEnded) {
      opts.log(`client already disconnected; aborting run ${run.runId}`);
      await abortRun(run, "client disconnected");
      throw new Error("client disconnected");
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
        unindexRun(run);
        const calls = segment.calls;
        for (const call of calls) {
          run.pendingCalls.set(call.toolCallId, call);
          parkedByToolId.set(call.toolCallId, run);
        }
        run.inFlight = false;
        armTtl(run);
        const formatted = formatToolCalls(run, calls);
        requestFinished = true;
        return {
          completion: toolCallsToJson(body, formatted, run.model),
          finishReason: "tool_calls",
        };
      }

      if (run.incomingQueue.length > 0) {
        // Unlikely, but if a call arrived right before run/ended won the race,
        // answer it cleanly before finalizing.
        for (const call of run.incomingQueue.splice(0)) {
          call.reply({ error: { message: "run ended" } });
        }
      }

      const ended = segment.ended;
      await finishRun(run, false);
      requestFinished = true;

      try {
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
      } finally {
        cleanupRunDir(run.outputDir);
      }
    } catch (err) {
      await abortRun(run, err instanceof Error ? err.message : "run failed");
      const conflict = err instanceof Error ? CONFLICT_RE.exec(err.message) : null;
      if (conflict && !match && !reservedToolNames.has(conflict[1])) {
        reservedToolNames.add(conflict[1]);
        opts.log(`tool name "${conflict[1]}" is reserved by the engine; retrying renamed`);
        res.off("close", onClientClose);
        return runCompletion(body, res);
      }
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
    includeUsage: boolean,
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
    if (includeUsage && completion.usage) {
      res.write(
        "data: " +
          JSON.stringify({
            id: completion.id,
            object: "chat.completion.chunk",
            created: completion.created,
            model: completion.model,
            choices: [],
            usage: completion.usage,
          }) +
          "\n\n",
      );
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
            const includeUsage = Boolean(
              body.stream_options &&
                typeof body.stream_options === "object" &&
                (body.stream_options as Record<string, unknown>).include_usage,
            );
            writeSseCompletion(res, completion, finishReason, includeUsage);
          } else {
            send(res, 200, completion);
          }
        } catch (err: any) {
          opts.log(`completion failed: ${err.message}`);
          if (!res.headersSent && !res.destroyed) {
            const status = typeof err?.statusCode === "number" ? err.statusCode : 502;
            const type = status === 409 ? "conflict_error" : "upstream_error";
            send(res, status, { error: { message: err.message, type } });
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
