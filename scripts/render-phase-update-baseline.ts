// Per-file counts of `no-render-phase-update` findings that predate the rule
// (.oxlint-plugins/no-render-phase-update-baseline.json), held shrink-only by
// ./rule-count-baseline.ts.
//
//   bun scripts/render-phase-update-baseline.ts --check   exact counts; with
//                                                         BASE_SHA, no growth
//   bun scripts/render-phase-update-baseline.ts --write   lower counts, drop
//                                                         clean files
import { NO_RENDER_PHASE_UPDATE_GOVERNED_PATHS } from "../oxlint.config.ts";
import { BASELINE_PATHS } from "./baseline-paths.ts";
import { runRuleCountBaseline } from "./rule-count-baseline.ts";

// A finding needs a state setter, a navigation or a history call.
const CANDIDATE =
  /\buse(?:State|Reducer)\b|\bnavigate\b|\bredirect\b|\bhistory\b/u;

if (import.meta.main) {
  process.exit(
    runRuleCountBaseline({
      rule: "no-render-phase-update",
      baseline: BASELINE_PATHS.renderPhaseUpdate,
      governedPaths: NO_RENDER_PHASE_UPDATE_GOVERNED_PATHS,
      isCandidate: (source) => CANDIDATE.test(source),
      label: "Render-phase update",
    }),
  );
}
