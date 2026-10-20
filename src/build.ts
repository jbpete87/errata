import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { SampleFile } from "./check.ts";
import type { PackageConfig, SampleResult } from "./types.ts";
import { dir, pool, safe } from "./util.ts";

const MIN_FREE = 2 * 1024 ** 3;

function exec(cmd: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(join(cwd, "node_modules", ".bin", cmd[0]), cmd.slice(1), {
      cwd,
      env: { ...process.env, CI: "1", NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, output: String(e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

/**
 * Answers often import project helpers they were not asked to write (`@/lib/posts`). A real project
 * would have them, so give each missing one a stub exporting `any` for every name imported, rather
 * than letting "module not found" hide whatever the toolchain would have said about the answer.
 */
function stubMissingImports(proj: string, files: string[]) {
  const exts = ["", ".ts", ".tsx", ".js", "/index.ts", "/index.tsx"];
  const wanted = new Map<string, { names: Set<string>; types: Set<string>; def: boolean }>();
  for (const f of files) {
    const src = readFileSync(join(proj, f), "utf8");
    for (const m of src.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s+["']@\/([^"']+)["']/g)) {
      const target = m[3];
      if (exts.some((e) => existsSync(join(proj, target + e)))) continue;
      const w = wanted.get(target) ?? { names: new Set(), types: new Set(), def: false };
      const clause = m[2];
      const named = clause.match(/\{([^}]*)\}/)?.[1] ?? "";
      for (const part of named.split(",").map((p) => p.trim()).filter(Boolean)) {
        const typeOnly = !!m[1] || part.startsWith("type ");
        const name = part.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        (typeOnly ? w.types : w.names).add(name);
      }
      if (/^[A-Za-z_$][\w$]*/.test(clause.replace(/^type\s+/, "")) && !clause.trim().startsWith("{") && !clause.trim().startsWith("*")) w.def = true;
      wanted.set(target, w);
    }
  }
  for (const [target, w] of wanted) {
    const body = [
      ...[...w.names].map((n) => `export const ${n}: any = (() => undefined) as any;`),
      ...[...w.types].filter((n) => !w.names.has(n)).map((n) => `export type ${n} = any;`),
      w.def ? "export default (() => undefined) as any;" : "",
    ].join("\n");
    mkdirSync(dirname(join(proj, target + ".ts")), { recursive: true });
    writeFileSync(join(proj, target + ".ts"), `// errata stub: imported by the answer but not part of it\n${body}\n`);
  }
}

/** Strip what varies between runs (paths, numbers, quotes around names) so the same warning counts once. */
const normalize = (s: string) => s.replace(/\/[^\s"'`]+/g, "<path>").replace(/\d+(\.\d+)?/g, "N").replace(/\s+/g, " ").trim();

/**
 * Put each answer into a scaffolded project, run the package's own build, and record the warnings
 * it prints. This catches what a typecheck cannot: file conventions, config the toolchain rejects
 * or deprecates at build time.
 */
export async function build(wsDir: string, cfg: PackageConfig, samples: SampleFile[], results: SampleResult[], label: string, concurrency: number) {
  const b = cfg.build!;
  const warn = new RegExp(b.warn);
  const ignore = (b.ignore ?? []).map((p) => new RegExp(p));
  const free = statfsSync(wsDir);
  if (free.bavail * free.bsize < MIN_FREE) throw new Error(`Less than 2 GB free on disk; not running ${cfg.name} builds.`);
  if (!existsSync(join(wsDir, "node_modules", ".bin", b.command[0]))) throw new Error(`${b.command[0]} not found in ${wsDir}/node_modules/.bin`);

  // One build at a time: answers share the workspace's node_modules, and parallel Turbopack builds
  // over the same symlinked node_modules failed at random.
  void concurrency;
  await pool(samples, 1, async (s, i) => {
    const result = results[i];
    if (!result.valid || !s.root) return;
    const proj = join(dir(wsDir, "build", safe(label)), `${safe(s.task)}.${s.sample}`);
    rmSync(proj, { recursive: true, force: true });
    mkdirSync(proj, { recursive: true });
    symlinkSync(join(wsDir, "node_modules"), join(proj, "node_modules"));
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "errata-build", private: true, type: "module" }));
    const answer = new Set((s.files ?? []).map((f) => relative(s.root!, f)));
    for (const [path, content] of Object.entries(b.scaffold)) {
      if (answer.has(path)) continue;
      mkdirSync(dirname(join(proj, path)), { recursive: true });
      writeFileSync(join(proj, path), content);
    }
    for (const f of s.files ?? []) cpSync(f, join(proj, relative(s.root, f)));
    stubMissingImports(proj, [...answer].filter((f) => /\.[cm]?[jt]sx?$/.test(f)));

    const run = await exec(b.command, proj, b.timeoutMs ?? 120_000);
    const code = run.code;
    const output = run.output.replace(/\x1b\[[0-9;]*m/g, "");
    for (const d of b.cleanup ?? []) rmSync(join(proj, d), { recursive: true, force: true });

    result.build = { ok: code === 0 };
    if (code !== 0) result.build.note = output.split("\n").filter((l) => /error/i.test(l)).slice(0, 3).join(" | ").slice(0, 400) || `exit ${code}`;
    const files = [...answer].join(", ");
    const lines = output.split("\n");
    const located = b.error ? new RegExp(b.error) : null;
    const messages: string[] = [];
    lines.forEach((line, n) => {
      const m = line.match(warn);
      if (m) messages.push((m[1] ?? line).trim());
      // A located build error is a finding too: the toolchain rejected the answer outright.
      if (located?.test(line.trim())) {
        const next = lines.slice(n + 1).find((l) => l.trim());
        if (next) messages.push(next.trim());
      }
    });
    for (const message of messages) {
      if (ignore.some((r) => r.test(message))) continue;
      const key = `build:${normalize(message).slice(0, 120)}`;
      if (result.findings.some((f) => f.key === key)) continue;
      result.findings.push({ kind: "build", key, code: 0, name: message.slice(0, 60), message: message.slice(0, 500), snippet: `answer files: ${files}`, declPkg: cfg.name, decl: `printed by \`${b.command.join(" ")}\`` });
    }
  });
}
