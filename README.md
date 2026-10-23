# errata

Measure what a model wrongly believes about a package, and write the smallest card that fixes it.

A model's knowledge of a library stops at its training cutoff. `errata` asks the model to do
realistic tasks from memory, typechecks the answers against the package as published today,
turns each mistake into a one-line correction, then re-asks with the corrections in context
and keeps only the lines that measurably helped.

First results for `claude-opus-5-5` and `claude-haiku-5-5` across thirteen packages are in
[FINDINGS.md](FINDINGS.md): the frontier model is mostly current, the smaller one makes nearly
five times as many build-breaking mistakes, and one-to-six-line cards remove almost all of them.

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
   Packages with a `build` config are also run through their own toolchain: each answer goes into
   a scaffolded project at the paths the model chose, the package's build runs, and the warnings
   it prints count as findings. This catches what types cannot, such as a deprecated file name
   (`middleware.ts` in Next 16). Helper modules an answer imports but does not include
   (`@/lib/posts`) get stubs, so a missing file does not hide everything else.
4. **Card**: the model writes one correction line per root cause, given the code, the compiler
   message and the real declaration.
5. **Verify**: the tasks are re-run with the card shown as project notes. A line is kept only if
   the mistakes it covers occur less often than before. Mistakes that surface only after earlier
   ones are fixed get their own lines and another round (`--rounds`).

## Adding a package

- `packages/<name>.json`: `name`, plus optional `extras` (installed alongside and offered to the
  model), `family` (name prefixes that count as the same package), `tsx`, `context`, and `types`
  (ambient declaration files to load, e.g. `astro/client`, for packages with virtual modules or
  global augmentations), and `build`: `command` (run from `node_modules/.bin`), `scaffold`
  (files written first; answer files at the same path win), `warn` (regex for finding lines),
  `ignore` (regexes for noise), `cleanup` and `timeoutMs`. See `packages/next.json`. Extras may pin
  a version (`typescript@5`).
- `tasks/<name>.json`: `[{ "id", "goal" }]`. Describe the goal in user terms and do not name the
  API, so the probe measures what the model reaches for unprompted.

## Limits

- Code is not executed. Packages without a `build` config are judged on types and deprecations
  only; with one, only what the toolchain prints at build time is added. Behaviour that changes at
  runtime with the same types is still invisible.
- Build failures are recorded per sample but not turned into findings yet; only warnings are.
- TypeScript/npm only, and the package needs type declarations.
- One model call path: the `claude` CLI. The model is whatever the CLI reports. Use
  `--card-model` to have a stronger model write the card while the probed model verifies it;
  smaller models write noticeably worse cards.
- With `--samples 1` a line can look verified by chance; use 3 or more before trusting a card.
- A line that does not help is dropped, not rewritten.
- A gap in the workspace can look like a mistake: if a package's global types are not loaded
  (see `types`), correct code fails to compile and a bogus line can be "verified" because the
  model simply avoids the construct. Read a new package's first card before trusting it.
- `sync` reads `package-lock.json` only; pnpm, yarn and bun lockfiles need `node_modules` present.

## License

MIT
