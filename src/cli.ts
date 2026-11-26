import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createShimServer } from "./server";
import { VibeRunServer } from "./runserver";
import { discoverModels } from "./models";

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0] || "serve";
  const opts = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts.set(key, next);
        i++;
      } else {
        opts.set(key, "true");
      }
    }
  }

  const port = parseInt(opts.get("port") || process.env.VIBE_SHIM_PORT || "8126", 10);
  const stateDir =
    process.env.VIBE_SHIM_STATE ||
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "zed-shims");
  const logDir = join(stateDir, "vibe-shim");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, "shim.log");
  const log = (line: string) => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    console.log(stamped);
    try {
      appendFileSync(logFile, stamped + "\n");
    } catch {
      /* best effort */
    }
  };

  if (cmd === "models") {
    const port = parseInt(opts.get("port") || process.env.VIBE_SHIM_PORT || "8126", 10);
    const models = discoverModels();
    const snippet = {
      language_models: {
        openai_compatible: {
          vibe: {
            api_url: `http://127.0.0.1:${port}/v1`,
            api_key: "dummy",
            available_models: models.map((m) => ({
              name: m.alias,
              display_name: m.displayName,
              max_tokens: 128000,
              capabilities: {
                tools: true,
                images: false,
                parallel_tool_calls: true,
                prompt_cache_key: false,
                chat_completions: true,
                interleaved_reasoning: false,
              },
            })),
          },
        },
      },
    };
    console.log(JSON.stringify(snippet, null, 2));
    return;
  }

  if (cmd === "logs") {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    try {
      const out = execSync(`tail -n 60 ${JSON.stringify(logFile)}`, { encoding: "utf8" });
      process.stdout.write(out);
    } catch {
      console.log("(sem log)");
    }
    return;
  }

  if (cmd !== "serve") {
    console.log("Uso: node dist/cli.js serve [--port 8126] [--workspace DIR] | models | logs");
    process.exitCode = cmd === "help" ? 0 : 2;
    return;
  }

  const workspace =
    opts.get("workspace") || process.env.VIBE_SHIM_WORKSPACE || process.cwd();
  const runsDir = join(logDir, "runs");
  mkdirSync(runsDir, { recursive: true });

  const runServer = new VibeRunServer();
  runServer.onStderr((chunk) => {
    for (const line of chunk.split("\n")) {
      if (line.trim()) log(`[vibe] ${line}`);
    }
  });

  void (async () => {
    await runServer.start();
    log(`vibe run-server no ar (workspace ${workspace})`);
    const server = createShimServer(runServer, {
      port,
      workspace,
      stateDir,
      runsDir,
      log,
    });
    server.listen(port, "127.0.0.1", () => {
      log(`vibe-shim ouvindo em http://127.0.0.1:${port}/v1`);
    });

    const shutdown = async () => {
      log("encerrando…");
      server.close();
      await runServer.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  })().catch((err) => {
    log(`falha ao subir: ${err.message}`);
    process.exit(1);
  });
}

main();
