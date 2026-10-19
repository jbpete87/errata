import { complete } from "./provider.ts";
import type { Finding, PackageConfig, SampleResult } from "./types.ts";
import { fenced } from "./util.ts";

const SYSTEM =
  "You write terse, accurate correction notes for coding agents. Reply with a single ```json code block and nothing else.";

/** Count how many samples exhibit each distinct mistake. */
export function tally(results: SampleResult[]): Map<string, { finding: Finding; count: number }> {
  const out = new Map<string, { finding: Finding; count: number }>();
  for (const r of results) {
    for (const f of r.findings) {
      const e = out.get(f.key);
      if (e) e.count++;
      else out.set(f.key, { finding: f, count: 1 });
    }
  }
  return out;
}

/** Turn observed mistakes into one correction line per root cause. */
export async function writeCard(cfg: PackageConfig, version: string, findings: Finding[], model?: string): Promise<{ text: string; keys: string[] }[]> {
  if (!findings.length) return [];
  const evidence = findings.map((f) => ({ key: f.key, kind: f.kind, code_written: f.snippet, compiler_says: f.message, actual_declaration: f.decl }));
  const prompt = `A model wrote code for ${cfg.name}@${version} from memory. The compiler found the problems below; each entry includes the real declaration from the installed package.

${JSON.stringify(evidence, null, 2)}

Write the corrections an agent needs so it does not repeat these mistakes. Rules:
- One line per root cause. Merge entries that share a cause and list every key the line covers.
- At most 30 words per line. Name the wrong usage and the right one, with exact identifiers.
- State only what the evidence shows. If the evidence does not reveal the replacement, say what no longer works and stop.

Return JSON: [{"text": "...", "keys": ["..."]}]`;
  const res = await complete(SYSTEM, prompt, { model });
  const lines = JSON.parse(fenced(res.text)) as { text: string; keys: string[] }[];
  const known = new Set(findings.map((f) => f.key));
  return lines
    .map((l) => ({ text: String(l.text).trim(), keys: (l.keys ?? []).filter((k) => known.has(k)) }))
    .filter((l) => l.text && l.keys.length);
}
