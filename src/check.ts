import ts from "typescript";
import { join } from "node:path";
import type { Finding, PackageConfig, SampleResult } from "./types.ts";

export interface SampleFile {
  task: string;
  sample: number;
  file: string;
}

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  types: ["node"],
};

function packageOf(file: string): string | null {
  const i = file.lastIndexOf("/node_modules/");
  if (i < 0) return null;
  const [a, b] = file.slice(i + "/node_modules/".length).split("/");
  return a.startsWith("@") ? `${a}/${b}` : a;
}

function nodeAt(sf: ts.SourceFile, pos: number): ts.Node {
  let node: ts.Node = sf;
  const visit = (n: ts.Node) => {
    if (pos >= n.getStart(sf) && pos < n.getEnd()) {
      node = n;
      n.forEachChild(visit);
    }
  };
  sf.forEachChild(visit);
  return node;
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + " …" : t;
};

/**
 * Typecheck every sample against the installed package and keep only the problems that
 * trace back to it: type errors whose offending symbol is declared by the package, bad
 * imports of the package, and uses of APIs the package marks @deprecated.
 */
export function check(wsDir: string, cfg: PackageConfig, samples: SampleFile[]): SampleResult[] {
  // One program per sample: a `declare global` in one answer must not leak into another.
  const registry = ts.createDocumentRegistry();
  const missing = new Set<string>();
  const results = samples.flatMap((s) => checkOne(wsDir, cfg, [s], registry, missing));
  const absent = [...missing].filter((m) => !m.startsWith(".") && !m.startsWith("node:"));
  if (absent.length) console.error(`  not installed, so not judged: ${absent.join(", ")} (add to "extras" in packages/${cfg.name}.json if answers should use them)`);
  return results;
}

function checkOne(wsDir: string, cfg: PackageConfig, samples: SampleFile[], registry: ts.DocumentRegistry, missing: Set<string>): SampleResult[] {
  const options = { ...OPTIONS, typeRoots: [join(wsDir, "node_modules", "@types")] };
  // Ambient declaration files (e.g. "astro/client") are loaded as extra roots so virtual modules resolve.
  const ambient = (cfg.types ?? []).map((t) => join(wsDir, "node_modules", `${t}.d.ts`));
  const files = [...samples.map((s) => s.file), ...ambient];
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) => (ts.sys.fileExists(f) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(f)!) : undefined),
    getCurrentDirectory: () => wsDir,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host, registry);
  const program = service.getProgram()!;
  const checker = program.getTypeChecker();

  const inFamily = (name: string) => name === cfg.name || (cfg.family ?? []).some((p) => name.startsWith(p));
  // Transitive dependencies count (a package's types often live in its internals); extras and @types do not.
  const relevant = (pkg: string | null): pkg is string =>
    !!pkg && pkg !== "typescript" && !pkg.startsWith("@types/") && (inFamily(pkg) || !(cfg.extras ?? []).includes(pkg));
  const ownsSpecifier = (spec: string) => inFamily(spec) || spec.startsWith(cfg.name + "/") || spec.startsWith(cfg.name + ":");

  const installed = (spec: string) => {
    const [a, b] = spec.split("/");
    return ts.sys.fileExists(join(wsDir, "node_modules", a.startsWith("@") ? `${a}/${b}` : a, "package.json"));
  };

  function declarationsOf(n: ts.Node): ts.Declaration[] {
    const out: ts.Declaration[] = [];
    const add = (s?: ts.Symbol) => {
      if (!s) return;
      if (s.flags & ts.SymbolFlags.Alias) {
        try { s = checker.getAliasedSymbol(s); } catch { /* unresolved import */ }
      }
      out.push(...(s.declarations ?? []));
    };
    const addType = (t?: ts.Type) => {
      if (!t) return;
      add(t.symbol);
      add(t.aliasSymbol);
      if (t.isUnion()) for (const u of t.types) { add(u.symbol); add(u.aliasSymbol); }
    };
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const sig = checker.getResolvedSignature(n);
      if (sig?.declaration) out.push(sig.declaration as ts.Declaration);
      add(checker.getSymbolAtLocation(n.expression));
    } else if (ts.isJsxOpeningLikeElement(n)) {
      const sig = checker.getResolvedSignature(n);
      if (sig?.declaration) out.push(sig.declaration as ts.Declaration);
      add(checker.getSymbolAtLocation(n.tagName));
    } else if (ts.isPropertyAccessExpression(n)) {
      add(checker.getSymbolAtLocation(n.name));
      addType(checker.getTypeAtLocation(n.expression));
    } else if (ts.isIdentifier(n)) {
      add(checker.getSymbolAtLocation(n));
    } else if (ts.isObjectLiteralExpression(n)) {
      addType(checker.getContextualType(n));
    } else if (ts.isObjectBindingPattern(n)) {
      // `({ data }: MetaArgs) => ...`: the property is looked up on the type being destructured.
      addType(checker.getTypeAtLocation(n));
    }
    return out;
  }

  /** Walk outward from the error until something declared by the package turns up. */
  function attribute(start: ts.Node, code = 0): { declPkg: string; decl: string } | null {
    let n: ts.Node | undefined = start;
    for (let depth = 0; n && !ts.isSourceFile(n) && depth < 12; depth++, n = n.parent) {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
        const spec = n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : "";
        // An import of something that is not installed is a gap in the workspace, not a wrong belief.
        if (code === 2307 && !installed(spec)) { missing.add(spec); return null; }
        return ownsSpecifier(spec) ? { declPkg: cfg.name, decl: `import from "${spec}"` } : null;
      }
      for (const d of declarationsOf(n)) {
        const pkg = packageOf(d.getSourceFile().fileName);
        if (relevant(pkg)) return { declPkg: pkg, decl: describe(d) };
      }
      if (ts.isStatement(n)) break;
    }
    return null;
  }

  function describe(d: ts.Declaration): string {
    const note = ts.getJSDocDeprecatedTag(d)?.comment;
    const deprecated = note ? `@deprecated ${typeof note === "string" ? note : note.map((p) => p.text).join("")}\n` : "";
    return deprecated + oneLine(d.getText(), 600);
  }

  /** When the bad value is itself a call into the package (`x: f()`), that call's real signature is the useful evidence. */
  function valueSignature(n: ts.Node): string {
    const holder = n.parent;
    let value = holder && (ts.isPropertyAssignment(holder) || ts.isVariableDeclaration(holder)) ? holder.initializer : undefined;
    if (value && ts.isAwaitExpression(value)) value = value.expression;
    if (!value || !ts.isCallExpression(value)) return "";
    const d = checker.getResolvedSignature(value)?.declaration;
    return d && relevant(packageOf(d.getSourceFile().fileName)) ? describe(d as ts.Declaration) + "\n" : "";
  }

  const enclosingCall = (n: ts.Node): string => {
    for (let p: ts.Node | undefined = n.parent; p && !ts.isSourceFile(p); p = p.parent) {
      if (ts.isCallExpression(p) || ts.isNewExpression(p)) return oneLine(p.expression.getText(), 40);
    }
    return "";
  };

  return samples.map(({ task, sample, file }) => {
    const sf = program.getSourceFile(file);
    const result: SampleResult = { task, sample, file, valid: false, findings: [], unrelated: 0 };
    if (!sf || !sf.text.trim() || service.getSyntacticDiagnostics(file).length) return result;
    result.valid = true;
    const seen = new Set<string>();
    const push = (f: Finding) => {
      if (!seen.has(f.key)) { seen.add(f.key); result.findings.push(f); }
    };
    const lineOf = (pos: number) => oneLine(sf.text.split("\n")[sf.getLineAndCharacterOfPosition(pos).line], 200);

    for (const d of service.getSemanticDiagnostics(file)) {
      if (d.category !== ts.DiagnosticCategory.Error || d.start === undefined) continue;
      const node = nodeAt(sf, d.start);
      const hit = attribute(node, d.code);
      if (!hit) { result.unrelated++; continue; }
      const name = ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : oneLine(node.getText(), 40);
      const call = enclosingCall(node);
      push({
        kind: "error",
        key: `error:${d.code}:${name}${call && call !== name ? "@" + call : ""}`,
        code: d.code,
        name,
        message: oneLine(ts.flattenDiagnosticMessageText(d.messageText, "\n"), 500),
        snippet: lineOf(d.start),
        declPkg: hit.declPkg,
        decl: valueSignature(node) + hit.decl,
      });
    }

    for (const d of service.getSuggestionDiagnostics(file)) {
      if (!d.reportsDeprecated) continue;
      const node = nodeAt(sf, d.start);
      const hit = attribute(node);
      if (!hit) continue;
      const name = oneLine(node.getText(), 40);
      push({ kind: "deprecated", key: `deprecated:${name}`, code: d.code, name, message: oneLine(ts.flattenDiagnosticMessageText(d.messageText, "\n"), 300), snippet: lineOf(d.start), ...hit });
    }
    return result;
  });
}
