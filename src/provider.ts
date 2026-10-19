import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE, dir, sha } from "./util.ts";

export interface Completion {
  text: string;
  model: string;
}

function claudeBin(): string {
  if (process.env.ERRATA_CLAUDE_BIN) return process.env.ERRATA_CLAUDE_BIN;
  if (spawnSync("which", ["claude"]).status === 0) return "claude";
  if (process.env.CLAUDE_CODE_EXECPATH && existsSync(process.env.CLAUDE_CODE_EXECPATH)) return process.env.CLAUDE_CODE_EXECPATH;
  throw new Error("No claude CLI found. Install Claude Code or set ERRATA_CLAUDE_BIN.");
}

function runClaude(system: string, prompt: string, model?: string): Promise<Completion> {
  // No tools and an empty cwd: the model must answer from memory, not by reading node_modules or docs.
  const args = ["-p", "--output-format", "json", "--tools", "", "--system-prompt", system,
    "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", ""];
  if (model) args.push("--model", model);
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, { cwd: dir(STATE, "empty"), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      const start = out.indexOf("{");
      let json: any;
      try { json = JSON.parse(out.slice(start)); } catch { return reject(new Error(`claude returned no JSON: ${(err || out).slice(0, 300)}`)); }
      if (json.is_error) {
        const hint = /not logged in/i.test(json.result ?? "") ? " (run `claude auth login` in a terminal first)" : "";
        return reject(new Error(`claude: ${json.result}${hint}`));
      }
      const usage: Record<string, { outputTokens?: number }> = json.modelUsage ?? {};
      const main = Object.entries(usage).sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0]?.[0];
      resolve({ text: json.result ?? "", model: main ?? model ?? "unknown" });
    });
    child.stdin.end(prompt);
  });
}

/** Cached completion. `slot` separates repeated samples of the same prompt. */
export async function complete(system: string, prompt: string, opts: { model?: string; slot?: number } = {}): Promise<Completion> {
  const file = join(dir(STATE, "cache"), sha(JSON.stringify([opts.model ?? "", system, prompt, opts.slot ?? 0])) + ".json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const res = await runClaude(system, prompt, opts.model);
  writeFileSync(file, JSON.stringify(res, null, 2));
  return res;
}
