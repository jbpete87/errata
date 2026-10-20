#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { check } from "./check.ts";
import { tally } from "./card.ts";
import { loadPackage, run, summarize } from "./run.ts";
import { pct } from "./util.ts";
import { sync } from "./sync.ts";
import { ensureWorkspace } from "./workspace.ts";

const USAGE = `errata <command>

  run <package>            probe the model, write a card, re-probe with the card
      --version <v>        package version or dist-tag (default: latest)
      --samples <n>        answers per task (default: 1)
      --rounds <n>         card/verify rounds (default: 2)
      --min-count <n>      samples a mistake must appear in to get a card line (default: 2)
      --model <id>         passed to claude --model (default: the CLI's default)
      --concurrency <n>    parallel model calls (default: 3)

  check <package> <dir>    typecheck existing .ts/.tsx answers in <dir> against the package
      --version <v>

  sync [project-dir]       write the cards matching a project's installed packages into its
                           AGENTS.md (or CLAUDE.md if that is the one that exists)
      --model <id>         which model's cards to use (default: the only one in the registry)
      --file <name>        target file inside the project
      --dry-run            report what would change without writing
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    version: { type: "string", default: "latest" },
    samples: { type: "string", default: "1" },
    rounds: { type: "string", default: "2" },
    "min-count": { type: "string", default: "2" },
    model: { type: "string" },
    concurrency: { type: "string", default: "3" },
    file: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const [command, pkg, target] = positionals;

try {
  if (command === "run" && pkg) {
    await run(pkg, { version: values.version, samples: Number(values.samples), rounds: Number(values.rounds), minCount: Number(values["min-count"]), model: values.model, concurrency: Number(values.concurrency) });
  } else if (command === "sync") {
    sync(resolve(pkg ?? "."), { model: values.model, file: values.file, dryRun: values["dry-run"] });
  } else if (command === "check" && pkg && target) {
    const cfg = loadPackage(pkg);
    const ws = ensureWorkspace(cfg, values.version);
    // Samples must sit inside the workspace so imports resolve against its node_modules.
    const { cpSync } = await import("node:fs");
    const staged = join(ws.dir, "probe", "external");
    cpSync(resolve(target), staged, { recursive: true });
    const files = readdirSync(staged).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"));
    const results = check(ws.dir, cfg, files.map((f) => ({ task: f, sample: 0, file: join(staged, f) })));
    const s = summarize("check", results);
    console.log(`${cfg.name}@${ws.version}: ${s.valid}/${s.samples} valid files, no errors ${pct(s.passing, s.valid)}, ${s.errors} errors, ${s.deprecations} deprecations`);
    for (const { finding: f, count } of tally(results).values()) {
      console.log(`\n[${f.kind}] ${f.name}  x${count}  (${f.declPkg})\n  wrote: ${f.snippet}\n  says:  ${f.message}\n  real:  ${f.decl.slice(0, 240)}`);
    }
    const unrelated = results.reduce((n, r) => n + r.unrelated, 0);
    if (unrelated) console.log(`\n${unrelated} type errors not attributed to ${cfg.name} were ignored.`);
  } else {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
