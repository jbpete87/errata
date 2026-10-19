# errata

Measure what a model wrongly believes about a package, and write the smallest card that fixes it.

A model's knowledge of a library stops at its training cutoff. `errata` asks the model to do
realistic tasks from memory, typechecks the answers against the package as published today,
turns each mistake into a one-line correction, then re-asks with the corrections in context
and keeps only the lines that measurably helped.

## Use

Requires Node 24+ and a logged-in `claude` CLI (`claude auth login`).

```bash
npm install
node src/cli.ts run ai
node src/cli.ts run vitest --samples 3
```

Results land in `registry/<model>/<package>/<version>.json`, with the verified card next to it as `.md`.

To typecheck answers you already have, without calling a model:

```bash
node src/cli.ts check ai path/to/answers
```

To put the cards that match a project's installed packages into its agent notes file:

```bash
node src/cli.ts sync path/to/project --dry-run
node src/cli.ts sync path/to/project
```

`sync` reads versions from `node_modules` or `package-lock.json`, picks cards for the same major
measured at or before the installed version, and writes them between `errata` markers in
`AGENTS.md` (or `CLAUDE.md` if that is the file the project has). Re-running replaces the block;
if no card applies any more, the block is removed.

## How a run works

1. **Install** the package and its extras into `.errata/ws/<package>@<version>`.
2. **Probe**: each task in `tasks/<package>.json` goes to `claude -p` with no tools and an empty
   working directory, so the answer comes from memory. Replies are cached in `.errata/cache`.
3. **Check**: each answer is typechecked on its own. A problem counts only if it traces back to the
   package: a type error on a symbol the package declares, a bad import of it, or use of an API
   it marks `@deprecated`. Everything else is counted as unrelated and ignored.
4. **Card**: the model writes one correction line per root cause, given the code, the compiler
   message and the real declaration.
5. **Verify**: the tasks are re-run with the card shown as project notes. A line is kept only if
   the mistakes it covers occur less often than before. Mistakes that surface only after earlier
   ones are fixed get their own lines and another round (`--rounds`).

## Adding a package

- `packages/<name>.json`: `name`, plus optional `extras` (installed alongside and offered to the
  model), `family` (name prefixes that count as the same package), `tsx`, `context`, and `types`
  (ambient declaration files to load, e.g. `astro/client`, for packages with virtual modules or
  global augmentations).
- `tasks/<name>.json`: `[{ "id", "goal" }]`. Describe the goal in user terms and do not name the
  API, so the probe measures what the model reaches for unprompted.

## Limits

- Typecheck and deprecations only. Code is not executed, so behaviour changes that keep the same
  types are invisible.
- TypeScript/npm only, and the package needs type declarations.
- One model call path: the `claude` CLI. The model is whatever the CLI reports.
- With `--samples 1` a line can look verified by chance; use 3 or more before trusting a card.
- A line that does not help is dropped, not rewritten.
- A gap in the workspace can look like a mistake: if a package's global types are not loaded
  (see `types`), correct code fails to compile and a bogus line can be "verified" because the
  model simply avoids the construct. Read a new package's first card before trusting it.
- `sync` reads `package-lock.json` only; pnpm, yarn and bun lockfiles need `node_modules` present.
