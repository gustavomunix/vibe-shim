import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, chmodSync, unlinkSync, promises as fsPromises } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export interface AgentToolDefinition {
  namespace: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  modelAccess: "direct" | "programmatic" | "both";
}

export interface PendingToolCall {
  callbackId: string;
  toolCallId: string;
  name: string; // raw "<namespace>.<name>" from vibe
  input: unknown;
  reply: (result: { output?: unknown; error?: { message: string; code?: string } }) => void;
}

const TOOL_TIMEOUT_SECONDS = 3600;

/** Resolve a Python >= 3.9 interpreter for Vibe's tool helper. */
function resolvePython(): string {
  const override = process.env.VIBE_SHIM_PYTHON;
  if (override) return override;
  for (const bin of ["python3", "python", "/usr/bin/python3"]) {
    try {
      const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
      if (probe.status === 0) return bin;
    } catch {
      /* try next */
    }
  }
  return "python3";
}

const RESOLVED_PYTHON = resolvePython();

export function createRunSocketPath(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const dir = `/tmp/vibe-shim-${uid}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return join(dir, `${randomBytes(4).toString("hex")}.sock`);
}

export interface AgentSocketOptions {
  socketPath?: string;
  workspace: string;
  log: (line: string) => void;
  python?: string;
  tools?: AgentToolDefinition[];
  onToolCall?: (call: PendingToolCall) => void;
}

/**
 * Per-run agent socket the vibe engine connects to. Serves a passthrough
 * sandbox (vibe's own tools run on this host, like the CLI) and the caller's
 * declared tools via tools/call. One connection per request: one line in,
 * one line out, compact JSON-RPC with camelCase fields.
 */
export class AgentSocketServer {
  private server: net.Server | null = null;
  private closed = false;
  readonly socketPath: string;
  private readonly workspace: string;
  private readonly log: (line: string) => void;
  private readonly python: string;
  private readonly tools: AgentToolDefinition[];
  private readonly onToolCall?: (call: PendingToolCall) => void;

  constructor(opts: AgentSocketOptions) {
    this.socketPath = opts.socketPath ?? createRunSocketPath();
    this.workspace = opts.workspace;
    this.log = opts.log;
    this.python = opts.python ?? RESOLVED_PYTHON;
    this.tools = opts.tools ?? [];
    this.onToolCall = opts.onToolCall;
  }

  listen(): Promise<string> {
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.socketPath), 0o700);
    const server = net.createServer({ allowHalfOpen: true }, (conn) =>
      this.handle(conn),
    );
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        chmodSync(this.socketPath, 0o600);
        resolve(this.socketPath);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      unlinkSync(this.socketPath);
    } catch {
      /* already removed */
    }
  }

  private reply(conn: net.Socket, id: unknown, result?: unknown, error?: unknown): void {
    if (conn.destroyed || conn.writableEnded) return;
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id };
    if (error !== undefined) msg.error = error;
    else msg.result = result ?? {};
    conn.write(JSON.stringify(msg) + "\n");
    conn.end();
  }

  private handle(conn: net.Socket): void {
    conn.setEncoding("utf8");
    let buf = "";
    conn.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let req: any;
        try {
          req = JSON.parse(line);
        } catch {
          this.reply(conn, null, undefined, { code: -32700, message: "parse error" });
          continue;
        }
        this.dispatch(conn, req).catch((err: Error) => {
          this.reply(conn, req.id, undefined, { code: -32000, message: err.message });
        });
      }
    });
    conn.on("error", () => conn.destroy());
  }

  private async dispatch(conn: net.Socket, req: any): Promise<void> {
    const { method, params, id } = req;
    switch (method) {
      case "agent/initialize": {
        const result: Record<string, unknown> = {
          protocolVersion: 2,
          workspace: this.workspace,
          python: this.python,
        };
        if (this.tools.length > 0) {
          result.tools = this.tools;
          result.toolTimeoutSeconds = TOOL_TIMEOUT_SECONDS;
        }
        this.reply(conn, id, result);
        return;
      }
      case "sandbox/execute": {
        const { command, cwd, timeout } = params;
        this.log(`sandbox/execute: ${String(command).slice(0, 100)}`);
        const result = await this.execute(command, cwd, timeout);
        this.reply(conn, id, result.result, result.error);
        return;
      }
      case "sandbox/readFile": {
        const { path, maxBytes } = params;
        let fd: fsPromises.FileHandle | null = null;
        try {
          fd = await fsPromises.open(path, "r");
          const buf = Buffer.alloc(Math.max(0, Math.min(maxBytes ?? 65536, 64 * 1024 * 1024)));
          const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
          this.reply(conn, id, {
            contentBase64: buf.subarray(0, bytesRead).toString("base64"),
          });
        } catch {
          this.reply(conn, id, { contentBase64: null });
        } finally {
          if (fd) {
            try {
              await fd.close();
            } catch {
              /* best effort */
            }
          }
        }
        return;
      }
      case "tools/call": {
        if (!this.onToolCall) {
          this.reply(conn, id, {
            error: { message: "vibe-shim: no tool handler registered for this run" },
          });
          return;
        }
        const callbackId = String(params?.callbackId ?? "");
        const name = String(params?.name ?? "");
        const toolCallId = String(params?.toolCallId ?? callbackId);
        const input = params?.input ?? {};
        let answered = false;
        const replyFn = (res: { output?: unknown; error?: { message: string; code?: string } }) => {
          if (answered) return;
          answered = true;
          this.reply(conn, id, res);
        };
        this.onToolCall({
          callbackId,
          toolCallId,
          name,
          input,
          reply: replyFn,
        });
        return;
      }
      default:
        this.reply(conn, id, undefined, { code: -32601, message: `unknown method ${method}` });
    }
  }

  private execute(
    command: string,
    cwd: string,
    timeout: number | null,
  ): Promise<{ result?: unknown; error?: unknown }> {
    return new Promise((resolve) => {
      const proc = spawn("sh", ["-c", command], {
        cwd: cwd && cwd !== "/" ? cwd : undefined,
        detached: true,
      });
      let out = "";
      let err = "";
      let killed = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              killed = true;
              if (proc.pid) {
                try {
                  process.kill(-proc.pid, "SIGKILL");
                } catch {
                  try {
                    proc.kill("SIGKILL");
                  } catch {
                    /* already gone */
                  }
                }
              } else {
                proc.kill("SIGKILL");
              }
              resolve({
                error: { code: -32001, message: `command timed out after ${timeout}s` },
              });
            }, timeout * 1000)
          : null;
      proc.stdout!.setEncoding("utf8");
      proc.stderr!.setEncoding("utf8");
      proc.stdout!.on("data", (d: string) => (out += d));
      proc.stderr!.on("data", (d: string) => (err += d));
      proc.once("exit", (code) => {
        if (killed) return; // already replied with the timeout error
        if (timer) clearTimeout(timer);
        resolve({
          result: {
            exitCode: code ?? -1,
            stdout: out,
            stderr: err,
          },
        });
      });
      proc.once("error", (e) => {
        if (timer) clearTimeout(timer);
        resolve({ error: { code: -32000, message: e.message } });
      });
    });
  }
}
