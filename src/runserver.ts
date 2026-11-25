import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/** Params of run/ended, the one notification the run-server sends per run. */
export interface RunEndedParams {
  runId: string;
  outcome: string;
  exitCode: number;
  sessionId: string | null;
  error: { message: string; code: string | null } | null;
  exportPath: string | null;
  exportError: string | null;
}

export interface StartRunParams {
  runId: string;
  prompt: string;
  agentSocket: string;
  outputDir: string;
  autoApprove?: boolean;
  enabledTools?: string[];
  config?: Record<string, unknown>;
  maxTurns?: number;
  timeLimit?: number;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * Manages the `vibe run-server` child process: JSON-RPC 2.0 over stdio,
 * one compact JSON message per line. `run/start` answers immediately; the
 * run's end arrives later as a `run/ended` notification routed to the
 * matching waiter.
 */
export class VibeRunServer {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly replies = new Map<number, Pending>();
  private readonly runs = new Map<string, (p: RunEndedParams) => void>();
  private readonly stderrListeners: ((chunk: string) => void)[] = [];

  constructor(private readonly bin = process.env.VIBE_BIN || "vibe") {}

  onStderr(fn: (chunk: string) => void): void {
    this.stderrListeners.push(fn);
  }

  async start(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) return;
    const proc = spawn(this.bin, ["run-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout!.setEncoding("utf8");
    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line: string) => this.handleLine(line));

    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (d: string) => {
      for (const fn of this.stderrListeners) fn(d);
    });

    await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "vibe-shim", version: "0.1.0" },
    });
  }

  /** Send a request and wait for the reply with the same id. */
  private request(method: string, params: unknown): Promise<unknown> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) {
      return Promise.reject(new Error("vibe run-server is not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.replies.set(id, { resolve, reject });
      proc.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // stray output on stdout; protocol lines only are guaranteed
    }
    if (msg.method === "run/ended") {
      const waiter = this.runs.get(msg.params?.runId);
      if (waiter) {
        this.runs.delete(msg.params.runId);
        waiter(msg.params as RunEndedParams);
      }
      return;
    }
    if (msg.id !== undefined && this.replies.has(msg.id)) {
      const pending = this.replies.get(msg.id)!;
      this.replies.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || "run-server error"));
      else pending.resolve(msg.result);
    }
  }

  /** Start a run; resolves when its run/ended notification arrives. */
  async startRun(params: StartRunParams): Promise<RunEndedParams> {
    await this.request("run/start", params); // answers at once, {} on ok
    return new Promise<RunEndedParams>((resolve, reject) => {
      this.runs.set(params.runId, resolve);
      const proc = this.proc;
      if (proc) {
        proc.once("exit", () => {
          if (this.runs.delete(params.runId)) {
            reject(new Error("vibe run-server exited mid-run"));
          }
        });
      }
    });
  }

  async stopRun(runId: string): Promise<void> {
    try {
      await this.request("run/stop", { runId });
    } catch {
      /* run already gone */
    }
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    proc.stdin?.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 5000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
