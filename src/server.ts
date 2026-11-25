import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { VibeRunServer, RunEndedParams } from "./runserver";
import { AgentSocketServer } from "./agentsocket";
import { discoverModels, VibeModel } from "./models";
import {
  ChatCompletionRequest,
  computePrompt,
  readRunResult,
  completionToJson,
} from "./translate";

export interface ServerOptions {
  port: number;
  workspace: string;
  stateDir: string;
  runsDir: string;
  log: (line: string) => void;
}

const RUN_TIMEOUT_MS = 10 * 60 * 1000;

export function createShimServer(
  runServer: VibeRunServer,
  agentSocket: AgentSocketServer,
  socketPath: string,
  opts: ServerOptions,
): http.Server {
  // Discovered once at boot from the account's own catalog (see models.ts);
  // re-run `vibe-shim models` or restart the shim after the account's
  // available models change.
  let catalog: VibeModel[] = [];
  try {
    catalog = discoverModels();
    opts.log(`catálogo descoberto: ${catalog.map((m) => m.alias).join(", ")}`);
  } catch (err: any) {
    opts.log(`falha ao descobrir catálogo: ${err.message}`);
  }
  const defaultAlias = catalog[0]?.alias;

  const send = (res: http.ServerResponse, code: number, body: unknown) => {
    const json = JSON.stringify(body);
    res.writeHead(code, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(json),
    });
    res.end(json);
  };

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
          const completion = await runCompletion(body);
          if (body.stream) {
            res.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });
            const base = completion as Record<string, any>;
            const chunk = (delta: unknown, finish: string | null) =>
              "data: " +
              JSON.stringify({
                id: base.id,
                object: "chat.completion.chunk",
                created: base.created,
                model: base.model,
                choices: [{ index: 0, delta, finish_reason: finish }],
              }) +
              "\n\n";
            res.write(chunk({ role: "assistant" }, null));
            res.write(chunk({ content: base.choices[0].message.content }, null));
            res.write(chunk({}, "stop"));
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            send(res, 200, completion);
          }
        } catch (err: any) {
          opts.log(`completion failed: ${err.message}`);
          send(res, 502, { error: { message: err.message, type: "upstream_error" } });
        }
      });
      return;
    }
    send(res, 404, { error: { message: `no route ${req.method} ${req.url}` } });
  });

  async function runCompletion(body: ChatCompletionRequest): Promise<unknown> {
    if (Array.isArray((body as any).tools) && (body as any).tools.length) {
      opts.log("warning: client sent tools; tool bridge pending, running without them");
    }
    const prompt = computePrompt(body.messages);
    const runId = randomUUID();
    const outputDir = join(opts.runsDir, runId);
    mkdirSync(outputDir, { recursive: true });

    const config: Record<string, unknown> = {};
    const knownAliases = new Set(catalog.map((m) => m.alias));
    if (body.model && knownAliases.has(body.model)) {
      config.active_model = body.model;
    } else if (body.model && defaultAlias) {
      opts.log(`modelo "${body.model}" desconhecido; usando default ${defaultAlias}`);
      config.active_model = defaultAlias;
    }

    let ended: RunEndedParams;
    const timer = setTimeout(() => {
      void runServer.stopRun(runId);
    }, RUN_TIMEOUT_MS);
    try {
      ended = await runServer.startRun({
        runId,
        prompt,
        agentSocket: socketPath,
        outputDir,
        autoApprove: true,
        enabledTools: [],
        ...(Object.keys(config).length ? { config } : {}),
      });
    } finally {
      clearTimeout(timer);
    }

    const exportFile = join(opts.runsDir, runId, "export.json");
    if (existsSync(exportFile)) {
      try {
        const { text, exportInfo } = readRunResult(outputDir);
        return completionToJson(body, text, exportInfo, null);
      } catch (err: any) {
        opts.log(`export read failed: ${err.message}`);
      }
    }
    const message =
      ended.error?.message ||
      `run ended as ${ended.outcome || "outcome=unknown"}`;
    throw new Error(`vibe run: ${message}` + buildExtra(ended, opts.runsDir, runId));
  }

  return server;
}

function buildExtra(ended: RunEndedParams, runsDir: string, runId: string): string {
  void runsDir;
  void runId;
  void ended;
  return "";
}
