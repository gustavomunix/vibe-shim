import { spawnSync } from "node:child_process";

export interface VibeModel {
  alias: string;
  displayName: string;
}

const PROBE_ALIAS = "__vibe_shim_probe_invalid__";

const ACRONYMS: Record<string, string> = { glm: "GLM", zai: "ZAI" };

function prettify(alias: string): string {
  const parts = alias.split("-");
  const words: string[] = [];
  for (const part of parts) {
    if (ACRONYMS[part.toLowerCase()]) {
      words.push(ACRONYMS[part.toLowerCase()]);
    } else if (/^\d+$/.test(part) && words.length && /\d$/.test(words[words.length - 1])) {
      words[words.length - 1] += `.${part}`; // "4", "0" -> "4.0"
    } else if (/^\d/.test(part)) {
      words.push(part);
    } else {
      words.push(part[0]?.toUpperCase() + part.slice(1));
    }
  }
  return words.join(" ");
}

/**
 * The account's real model aliases, scraped from vibe's own "Unknown model"
 * error: there is no catalog command, but `--model` rejects an unknown alias
 * and lists the valid ones in the same message. Reflects whatever catalog
 * vibe resolved for this account (can exceed the hardcoded source defaults).
 */
export function discoverModels(bin = process.env.VIBE_BIN || "vibe"): VibeModel[] {
  const result = spawnSync(
    bin,
    ["-p", "probe", "--model", PROBE_ALIAS, "--output", "json"],
    { encoding: "utf8", timeout: 30_000 },
  );
  const text = `${result.stdout || ""}${result.stderr || ""}`;
  const match = text.match(/Unknown model:.*?Available:\s*(.+)/s);
  if (!match) {
    throw new Error(
      `could not discover models from '${bin}' (exit ${result.status}): ${text.slice(0, 300)}`,
    );
  }
  const aliases = match[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return aliases.map((alias) => ({ alias, displayName: prettify(alias) }));
}
