export interface PackageConfig {
  /** npm package under test */
  name: string;
  /** other packages installed alongside it and offered to the model */
  extras?: string[];
  /** package-name prefixes that count as part of this package (e.g. "@ai-sdk/") */
  family?: string[];
  /** extra entries for compilerOptions.types, for packages that declare virtual modules */
  types?: string[];
  /** check samples as .tsx */
  tsx?: boolean;
  /** extra sentence added to every task prompt */
  context?: string;
  /** run the package's own toolchain over each answer, for mistakes types cannot show */
  build?: BuildConfig;
}

export interface BuildConfig {
  /** command run in the answer's project directory, resolved from node_modules/.bin */
  command: string[];
  /** project files written first; an answer file at the same path replaces them */
  scaffold: Record<string, string>;
  /** a toolchain output line matching this regex is a finding; group 1, if any, is the message */
  warn: string;
  /** an output line matching this regex locates a build error; the next non-empty line is its message */
  error?: string;
  /** output lines matching any of these are harness noise (also applied to error messages) */
  ignore?: string[];
  /** directories to delete after each build */
  cleanup?: string[];
  timeoutMs?: number;
}

export interface Task {
  id: string;
  goal: string;
}

export interface Finding {
  kind: "error" | "deprecated" | "build";
  /** stable id used to count the same mistake across samples */
  key: string;
  code: number;
  name: string;
  message: string;
  snippet: string;
  /** package the offending declaration lives in */
  declPkg: string;
  /** real declaration (or deprecation note) the model's code collided with */
  decl: string;
}

export interface SampleResult {
  task: string;
  sample: number;
  file: string;
  valid: boolean;
  findings: Finding[];
  /** type errors not attributable to the package under test */
  unrelated: number;
  /** outcome of the toolchain run, when the package has one */
  build?: { ok: boolean; note?: string };
}

export interface CardLine {
  text: string;
  keys: string[];
  /** index of the run the mistakes were first seen in */
  foundIn: number;
  before: number;
  after: number | null;
}

export interface RunSummary {
  label: string;
  samples: number;
  valid: number;
  passing: number;
  clean: number;
  errors: number;
  deprecations: number;
  warnings: number;
  buildFailures: number;
}
