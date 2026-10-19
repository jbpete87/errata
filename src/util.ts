import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const STATE = join(ROOT, ".errata");

export const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

export const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_");

export function dir(...parts: string[]) {
  const p = join(...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

export function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`Missing ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Pull the first fenced block out of a model reply, or the whole reply if there is none. */
export function fenced(text: string): string {
  const m = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  return (m ? m[1] : text).trim() + "\n";
}

export const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
