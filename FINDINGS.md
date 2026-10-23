# Findings, October 2026

What two Claude models get wrong, from memory, about thirteen npm packages, and whether a short
correction card fixes it. Every number below comes from the entries in [`registry/`](registry).

## Setup

- **Models:** `claude-opus-5-5` and `claude-haiku-5-5`, called through the `claude` CLI with no
  tools, so every answer is written from memory.
- **Tasks:** eight realistic tasks per package, phrased as goals without naming the API
  (["stream a reply to stdout and log the token usage"](tasks/ai.json), not "use `streamText`").
  Three answers per task; Next.js on Opus has five.
- **Checks:** each answer is typechecked against the package as published, keeping only errors
  and `@deprecated` uses that trace back to the package. Next.js answers also go through
  `next build`, so file-convention mistakes count.
- **Cards:** a mistake seen in at least two answers gets a one-line correction. The tasks are then
  re-run with the card as project notes, and a line is kept only if its mistake became rarer.
  Haiku's cards are written by Opus and verified on Haiku.

## Results

The twelve packages both models were run on:

| Model | Answers with no mistakes | Hard type errors | Deprecated APIs | Card lines |
|---|---|---|---|---|
| `claude-opus-5-5` | 271 / 304 (89%) | 7 | 37 | 10 |
| `claude-haiku-5-5` | 233 / 288 (81%) | 33 | 54 | 25 |

Per package, answers with no mistakes before and after the card:

| Package | Opus | Opus + card | Haiku | Haiku + card |
|---|---|---|---|---|
| `ai` 7.0.146 | 13/24 | 24/24 | 9/24 | 24/24 |
| `zod` 4.3.5 | 20/24 | 24/24 | 13/24 | 24/24 |
| `astro` 7.4.1 | 15/24 | 23/24 | 14/24 | 22/24 |
| `vitest` 5.0.5 | 22/24 | 24/24 | 18/24 | 24/24 |
| `next` 16.1.1 | 39/40 | no card | 19/24 | 24/24 |
| `expo` 58.0.16 | 21/24 | 24/24 | 24/24 | no card |
| `openai` 7.39.0 | 24/24 | no card | 22/24 | 23/24 |
| `stripe` 23.0.0 | 24/24 | no card | 22/24 | 23/24 |
| `react-router` 8.5.0 | 23/24 | no card | 21/24 | no card |
| `zustand` 5.0.9 | 23/24 | no card | 24/24 | no card |
| `@supabase/supabase-js` 2.90.1 | 23/24 | no card | 23/24 | no card |
| `resend` 6.4.0 | 24/24 | no card | 24/24 | no card |

"No card" means no mistake appeared in two or more answers.

## What it means

1. **A frontier model is mostly current.** Opus made 7 hard type errors in 304 answers. What it
   gets wrong is mostly deprecated APIs that still work: `generateObject` in `ai` 7,
   `z.string().email()` in Zod 4.
2. **A smaller model is out of date in ways that break builds.** Haiku made nearly five times as
   many hard errors: Zod options that no longer exist (`required_error`, `.ip()`), `request_id`
   for `requestID` in `openai`, Vitest config options that don't exist, and the `middleware.ts`
   file Next 16 renamed to `proxy.ts`.
3. **Old habits outlive the cutoff.** The most common mistake for both models is a Zod 4 change
   from July 2025, long before either model's training ended. A release date says little about
   which APIs a model gets wrong.
4. **Short, tested cards work.** Wherever a card was written, mistakes it covered went to zero or
   nearly zero, using one to six lines per package.
5. **Strong models should write the cards.** Haiku's own cards were longer and sometimes wrong (one
   suggested `@ts-ignore`). Written by Opus and verified on Haiku, the Zod card shrank from 8
   lines to 5 and still removed all 28 mistakes.

## Limits

- Two models from one vendor. Other models need API access the harness doesn't have yet.
- Typecheck, deprecations and Next.js build output only. Behaviour that changes at runtime with
  the same types is not measured.
- Eight hand-written tasks per package: "clean" means clean on those tasks.
- Three answers per task is small. A mistake seen once is reported as rare and gets no line.
- The harness had false positives along the way (missing global types, a missing optional
  package). Each was traced and fixed, and every number above was re-measured afterwards; see the
  limits in the [README](README.md).
