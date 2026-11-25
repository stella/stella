// Per-file counts of `no-effect-state-write` findings that predate the rule
// (.oxlint-plugins/no-effect-state-write-baseline.json), held shrink-only by
// ./rule-count-baseline.ts.
//
//   bun scripts/effect-state-write-baseline.ts --check   exact counts; with
//                                                        BASE_SHA, no growth
//   bun scripts/effect-state-write-baseline.ts --write   lower counts, drop
//                                                        clean files
import { NO_RENDER_PHASE_UPDATE_GOVERNED_PATHS } from "../oxlint.config.ts";
import { BASELINE_PATHS } from "./baseline-paths.ts";
import { runRuleCountBaseline } from "./rule-count-baseline.ts";

// A finding needs a state hook and an effect hook in the same file.
const STATE_HOOK = /\buse(?:State|Reducer)\b/u;
const EFFECT_HOOK =
  /\buse(?:Effect|LayoutEffect|InsertionEffect|IsomorphicLayoutEffect|MountEffect|ExternalSyncEffect)\b/u;

if (import.meta.main) {
  process.exit(
    runRuleCountBaseline({
      rule: "no-effect-state-write",
      baseline: BASELINE_PATHS.effectStateWrite,
      governedPaths: NO_RENDER_PHASE_UPDATE_GOVERNED_PATHS,
      isCandidate: (source) =>
        STATE_HOOK.test(source) && EFFECT_HOOK.test(source),
      label: "Effect state write",
    }),
  );
}
