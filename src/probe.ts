import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { complete } from "./provider.ts";
import type { SampleFile } from "./check.ts";
import type { PackageConfig, Task } from "./types.ts";
import { dir, fenced, pool, safe } from "./util.ts";

const SYSTEM =
  "You are a coding assistant working in a TypeScript project. Reply with one complete TypeScript file in a single ```ts code block and nothing else. Write the code the way you normally would; do not add commentary.";

export function buildPrompt(cfg: PackageConfig, task: Task, card: string[]): string {
  const deps = [cfg.name, ...(cfg.extras ?? [])].join(", ");
  // The card is presented the way it would reach an agent in practice: as a project notes file.
  const notes = card.length ? `Project notes (AGENTS.md):\n## ${cfg.name}\n${card.map((l) => `- ${l}`).join("\n")}\n\n` : "";
  return `${notes}Installed dependencies: ${deps}.${cfg.context ? " " + cfg.context : ""}\n\nTask: ${task.goal}`;
}

export interface ProbeRun {
  samples: SampleFile[];
  model: string;
}

/** Ask the model to do each task from memory and write its answers into the workspace. */
export async function probe(
  wsDir: string, cfg: PackageConfig, tasks: Task[],
  opts: { label: string; card: string[]; samples: number; model?: string; concurrency: number },
): Promise<ProbeRun> {
  const out = dir(wsDir, "probe", safe(opts.label));
  const jobs = tasks.flatMap((task) => Array.from({ length: opts.samples }, (_, sample) => ({ task, sample })));
  let model = opts.model ?? "unknown";
  let done = 0;
  const samples = await pool(jobs, opts.concurrency, async ({ task, sample }) => {
    const res = await complete(SYSTEM, buildPrompt(cfg, task, opts.card), { model: opts.model, slot: sample });
    model = res.model;
    const file = join(out, `${safe(task.id)}.${sample}.${cfg.tsx ? "tsx" : "ts"}`);
    writeFileSync(file, fenced(res.text));
    done++;
    if (process.stderr.isTTY) process.stderr.write(`\r  ${opts.label}: ${done}/${jobs.length}`);
    return { task: task.id, sample, file };
  });
  if (process.stderr.isTTY) process.stderr.write("\n");
  return { samples, model };
}
