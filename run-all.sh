#!/bin/sh
# Probe every package named on the command line, one after another, logging to .errata/logs.
# Each argument is "<package>" or "<package>@<version>" (e.g. zod@4.3.5, @supabase/supabase-js@2.90.1).
mkdir -p .errata/logs
for arg in "$@"; do
  case "$arg" in
    @*/*@*) p="${arg%@*}"; v="${arg##*@}" ;;
    @*) p="$arg"; v=latest ;;
    *@*) p="${arg%@*}"; v="${arg##*@}" ;;
    *) p="$arg"; v=latest ;;
  esac
  log=".errata/logs/${MODEL:-default}-$(echo "$p" | tr '/@' '__')-$v.log"
  node src/cli.ts run "$p" --version "$v" ${MODEL:+--model "$MODEL"} ${CARD_MODEL:+--card-model "$CARD_MODEL"} --samples "${SAMPLES:-3}" --concurrency "${CONCURRENCY:-5}" > "$log" 2>&1 || echo "FAILED $arg" >> .errata/logs/failed
done
