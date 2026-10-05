import { isDeepStrictEqual } from "node:util";

export const CANONICAL_CANCEL_STEP = {
  name: "Cancel failed merge-group run",
  uses: "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
  with: {
    retries: 0,
    script:
      "await github.rest.actions.cancelWorkflowRun({\n  ...context.repo,\n  run_id: context.runId,\n});\n",
  },
} as const;

export const isCanonicalFailureCancellation = (step: unknown) =>
  isDeepStrictEqual(step, {
    ...CANONICAL_CANCEL_STEP,
    if: "failure() && github.event_name == 'merge_group'",
  });
