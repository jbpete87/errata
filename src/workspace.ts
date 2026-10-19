import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageConfig } from "./types.ts";
import { STATE, dir, safe } from "./util.ts";

export interface Workspace {
  dir: string;
  version: string;
}

/** Install the package (and its extras) into an isolated directory to typecheck against. */
export function ensureWorkspace(cfg: PackageConfig, version = "latest"): Workspace {
  const resolved = /^\d/.test(version)
    ? version
    : execFileSync("npm", ["view", `${cfg.name}@${version}`, "version"], { encoding: "utf8" }).trim().split("\n").pop()!.replace(/^.*'(.+)'$/, "$1");
  const ws = dir(STATE, "ws", `${safe(cfg.name)}@${resolved}`);
  if (!existsSync(join(ws, ".installed"))) {
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "errata-ws", private: true, type: "module" }));
    const deps = [`${cfg.name}@${resolved}`, ...(cfg.extras ?? []), "@types/node"];
    console.error(`installing ${deps.join(" ")}`);
    execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "--legacy-peer-deps", ...deps], { cwd: ws, stdio: ["ignore", "ignore", "inherit"] });
    writeFileSync(join(ws, ".installed"), new Date().toISOString());
  }
  return { dir: ws, version: resolved };
}
