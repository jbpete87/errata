#!/bin/sh
# Probe every package named on the command line, one after another, logging to .errata/logs.
mkdir -p .errata/logs
for p in "$@"; do
  node src/cli.ts run "$p" --samples "${SAMPLES:-3}" --concurrency "${CONCURRENCY:-5}" > ".errata/logs/$p.log" 2>&1 || echo "FAILED $p" >> .errata/logs/failed
done
