import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "./build.ts";
import { check, type SampleFile } from "./check.ts";
import { tally, writeCard } from "./card.ts";
import { probe } from "./probe.ts";
import type { CardLine, PackageConfig, RunSummary, SampleResult, Task } from "./types.ts";
import { ROOT, dir, pct, readJson, safe } from "./util.ts";
import { ensureWorkspace } from "./workspace.ts";

export interface RunOptions {
  version: string;
  samples: number;
  rounds: number;
  /** a mistake must appear in at least this many samples of a run to get a card line */
  minCount: number;
  /** model that writes the card (default: the probed model); verification always uses the probed model */
  cardModel?: string;
  model?: string;
  concurrency: number;
}

export function summarize(label: string, results: SampleResult[]): RunSummary {
  const valid = results.filter((r) => r.valid);
  const errs = (r: SampleResult) => r.findings.filter((f) => f.kind === "error").length;
  const count = (r: SampleResult, kind: string) => r.findings.filter((f) => f.kind === kind).length;
  return {
    label,
    samples: results.length,
    valid: valid.length,
    passing: valid.filter((r) => errs(r) === 0).length,
    clean: valid.filter((r) => r.findings.length === 0).length,
    errors: valid.reduce((n, r) => n + errs(r), 0),
    deprecations: valid.reduce((n, r) => n + count(r, "deprecated"), 0),
    warnings: valid.reduce((n, r) => n + count(r, "build"), 0),
    buildFailures: valid.filter((r) => r.build && !r.build.ok).length,
  };
}

export const loadPackage = (name: string) => readJson<PackageConfig>(join(ROOT, "packages", `${safe(name)}.json`));
export const loadTasks = (name: string) => readJson<Task[]>(join(ROOT, "tasks", `${safe(name)}.json`));

/**
 * baseline probe -> card -> re-probe with the card. Mistakes that only surface once
 * earlier ones are fixed get their own lines and another round.
 */
export async function run(pkg: string, opts: RunOptions) {
  const cfg = loadPackage(pkg);
  const tasks = loadTasks(pkg);
  const ws = ensureWorkspace(cfg, opts.version);
  console.error(`${cfg.name}@${ws.version}: ${tasks.length} tasks x ${opts.samples} samples`);

  const evaluate = async (label: string, samples: SampleFile[]) => {
    const results = check(ws.dir, cfg, samples);
    if (cfg.build) await build(ws.dir, cfg, samples, results, label, opts.concurrency);
    return results;
  };

  const base = await probe(ws.dir, cfg, tasks, { label: "baseline", card: [], ...opts });
  const runs: SampleResult[][] = [await evaluate("baseline", base.samples)];
  const summaries = [summarize("baseline", runs[0])];
  const lines: CardLine[] = [];

  for (let round = 1; round <= opts.rounds; round++) {
    const latest = tally(runs[runs.length - 1]);
    const covered = new Set(lines.flatMap((l) => l.keys));
    // One sighting may be chance, and every line costs context in every session: require repeats.
    const fresh = [...latest.values()].filter((e) => !covered.has(e.finding.key) && e.count >= opts.minCount);
    const added = await writeCard(cfg, ws.version, fresh.map((e) => e.finding), opts.cardModel ?? opts.model);
    for (const l of added) {
      lines.push({ ...l, foundIn: runs.length - 1, before: l.keys.reduce((n, k) => n + (latest.get(k)?.count ?? 0), 0), after: null });
    }
    if (!added.length) break;

    // Lines already shown not to help are left out of the next attempt.
    const active = lines.filter((l) => l.after === null || l.after < l.before);
    const label = `with-card-${round}`;
    const again = await probe(ws.dir, cfg, tasks, { label, card: active.map((l) => l.text), ...opts });
    const results = await evaluate(label, again.samples);
    const counts = tally(results);
    for (const l of active) l.after = l.keys.reduce((n, k) => n + (counts.get(k)?.count ?? 0), 0);
    runs.push(results);
    summaries.push(summarize(label, results));
  }

  const verified = lines.filter((l) => l.after !== null && l.after < l.before);
  const final = tally(runs[runs.length - 1]);
  const coveredKeys = new Set(lines.flatMap((l) => l.keys));
  const entry = {
    package: cfg.name,
    version: ws.version,
    model: base.model,
    measured: new Date().toISOString().slice(0, 10),
    check: cfg.build ? `typecheck + @deprecated + \`${cfg.build.command.join(" ")}\` warnings` : "typecheck + @deprecated (no execution)",
    tasks: tasks.length,
    samplesPerTask: opts.samples,
    runs: summaries,
    card: verified.map((l) => l.text),
    lines,
    minCount: opts.minCount,
    cardModel: opts.cardModel ?? null,
    // Seen at baseline, but too rarely to earn a line.
    rare: [...tally(runs[0]).values()].filter((e) => e.count < opts.minCount).map((e) => ({ key: e.finding.key, count: e.count, message: e.finding.message, snippet: e.finding.snippet })),
    remaining: [...final.values()].filter((e) => !coveredKeys.has(e.finding.key)).map((e) => ({ ...e.finding, count: e.count })),
    samples: runs.map((r, i) => ({ run: summaries[i].label, results: r.map(({ file, ...rest }) => rest) })),
  };

  const out = dir(ROOT, "registry", safe(base.model), safe(cfg.name));
  writeFileSync(join(out, `${ws.version}.json`), JSON.stringify(entry, null, 2) + "\n");
  const card = join(out, `${ws.version}.md`);
  if (verified.length) writeFileSync(card, `## ${cfg.name}@${ws.version}\n${verified.map((l) => `- ${l.text}`).join("\n")}\n`);
  else rmSync(card, { force: true });
  report(entry.model, cfg.name, ws.version, summaries, lines);
  for (const r of entry.rare) console.log(`  [rare, no line] x${r.count}  ${r.message.slice(0, 140)}`);
  console.log(`\nregistry/${safe(base.model)}/${safe(cfg.name)}/${ws.version}.json`);
}

export function report(model: string, pkg: string, version: string, summaries: RunSummary[], lines: CardLine[]) {
  console.log(`\n${pkg}@${version} — ${model}`);
  for (const s of summaries) {
    console.log(`  ${s.label.padEnd(12)} no errors ${pct(s.passing, s.valid).padStart(4)}  no errors or deprecations ${pct(s.clean, s.valid).padStart(4)}  (${s.errors} errors, ${s.deprecations} deprecations${s.warnings || s.buildFailures ? `, ${s.warnings} build warnings, ${s.buildFailures} failed builds` : ""}, ${s.valid}/${s.samples} valid)`);
  }
  for (const l of lines) {
    const status = l.after === null ? "untested" : l.after < l.before ? "verified" : "no effect";
    console.log(`  [${status}] ${l.before} -> ${l.after ?? "?"}  ${l.text}`);
  }
}
