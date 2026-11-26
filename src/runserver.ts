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

interface ActiveRunWaiter {
  resolve: (p: RunEndedParams) => void;
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
  private startPromise: Promise<void> | null = null;
  private initialized = false;
  private nextId = 1;
  private readonly replies = new Map<number, Pending>();
  private readonly runs = new Map<string, ActiveRunWaiter>();
  private readonly stderrListeners: ((chunk: string) => void)[] = [];

  constructor(private readonly bin = process.env.VIBE_BIN || "vibe") {}

  onStderr(fn: (chunk: string) => void): void {
    this.stderrListeners.push(fn);
  }

  private isAlive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  private rejectAll(reason: string): void {
    const err = new Error(reason);
    for (const pending of this.replies.values()) {
      pending.reject(err);
    }
    this.replies.clear();
    for (const waiter of this.runs.values()) {
      waiter.reject(err);
    }
    this.runs.clear();
  }

  async start(): Promise<void> {
    if (this.isAlive() && this.initialized) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.spawnAndInitialize().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async spawnAndInitialize(): Promise<void> {
    const proc = spawn(this.bin, ["run-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.initialized = false;

    proc.stdout!.setEncoding("utf8");
    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line: string) => this.handleLine(line));

    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (d: string) => {
      for (const fn of this.stderrListeners) fn(d);
    });

    const onDown = (reason: string) => {
      rl.close();
      if (this.proc === proc) {
        this.proc = null;
        this.initialized = false;
      }
      this.rejectAll(reason);
    };

    proc.once("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      onDown(`vibe run-server exited (${detail})`);
    });
    proc.once("error", (err) => {
      onDown(`vibe run-server error: ${err.message}`);
    });

    await this.sendRequest(proc, "initialize", {
      protocolVersion: 1,
      clientInfo: { name: "vibe-shim", version: "0.1.0" },
    });
    if (this.proc === proc) {
      this.initialized = true;
    }
  }

  /** Send a request to a specific child process without lazy restart. */
  private sendRequest(proc: ChildProcess, method: string, params: unknown): Promise<unknown> {
    if (proc.exitCode !== null || proc.signalCode !== null || !proc.stdin || proc.stdin.destroyed) {
      return Promise.reject(new Error("vibe run-server is not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.replies.set(id, { resolve, reject });
      try {
        proc.stdin!.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
          (err) => {
            if (err && this.replies.delete(id)) {
              reject(err);
            }
          },
        );
      } catch (err) {
        this.replies.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Send a request, lazily starting or restarting the child if needed. */
  private async request(method: string, params: unknown): Promise<unknown> {
    if (!this.isAlive() || !this.initialized) {
      await this.start();
    }
    const proc = this.proc;
    if (!proc || !this.isAlive()) {
      throw new Error("vibe run-server is not running");
    }
    return this.sendRequest(proc, method, params);
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
        waiter.resolve(msg.params as RunEndedParams);
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

  /** Start a run; resolves once run/start is accepted, returning the run/ended promise wrapped in an object. */
  async launchRun(params: StartRunParams): Promise<{ ended: Promise<RunEndedParams> }> {
    if (!this.isAlive() || !this.initialized) {
      await this.start();
    }
    const ended = new Promise<RunEndedParams>((resolve, reject) => {
      this.runs.set(params.runId, { resolve, reject });
    });
    ended.catch(() => {});
    try {
      await this.request("run/start", params);
    } catch (err) {
      this.runs.delete(params.runId);
      throw err;
    }
    return { ended };
  }

  /** Start a run; resolves when its run/ended notification arrives. */
  async startRun(params: StartRunParams): Promise<RunEndedParams> {
    const { ended } = await this.launchRun(params);
    return ended;
  }

  async stopRun(runId: string): Promise<void> {
    if (!this.isAlive() || !this.initialized) return;
    try {
      await this.sendRequest(this.proc!, "run/stop", { runId });
    } catch {
      /* run already gone */
    }
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.initialized = false;
    if (!proc) return;
    proc.stdin?.end();
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }, 5000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
