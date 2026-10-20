import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageConfig } from "./types.ts";
import { STATE, dir, pkgName, safe } from "./util.ts";

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
  // Check for the package itself, not just the marker: node_modules can be cleaned out from under us,
  // and a missing package would make every answer look clean (unresolvable imports are not judged).
  const present = (name: string) => existsSync(join(ws, "node_modules", name, "package.json"));
  if (!existsSync(join(ws, ".installed")) || ![cfg.name, ...(cfg.extras ?? []).map(pkgName)].every(present)) {
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "errata-ws", private: true, type: "module" }));
    const deps = [`${cfg.name}@${resolved}`, ...(cfg.extras ?? []), "@types/node"];
    console.error(`installing ${deps.join(" ")}`);
    execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "--legacy-peer-deps", ...deps], { cwd: ws, stdio: ["ignore", "ignore", "inherit"] });
    writeFileSync(join(ws, ".installed"), new Date().toISOString());
  }
  return { dir: ws, version: resolved };
}
