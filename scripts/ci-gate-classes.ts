/**
 * Gate classes for every CI Checks job and for the steps that differ from
 * their job's class. The class decides what a failure blocks per event:
 *
 * - correctness: blocks pull requests and merge groups.
 * - budget: a performance or ratchet budget. Blocks the pull request that
 *   moves it; in a merge group it reports without ejecting the entry.
 * - time-based: a check that a clock can turn red (expiry, quarantine age).
 *   Blocks the pull request that touches the guarded entry; in a merge group
 *   it reports without ejecting the entry.
 * - advisory: reports only, never blocks.
 *
 * `scripts/ci-gate-classes.test.ts` keeps this table and
 * `.github/workflows/ci.yml` in step: every job needs a class, every listed
 * step must exist, budget and time-based steps need an owner, and each listed
 * step must carry the `continue-on-error` expression its class implies.
 */

export const GATE_CLASSES = [
  "correctness",
  "budget",
  "time-based",
  "advisory",
] as const;

export type GateClass = (typeof GATE_CLASSES)[number];

export type StepGate = {
  readonly class: Exclude<GateClass, "correctness">;
  /** Area that answers for the budget or expiry; required for budget and time-based. */
  readonly owner: string;
  /**
   * Set when another mechanism already scopes the failure to the pull
   * request that caused it, so the step keeps its own `continue-on-error`.
   */
  readonly enforcedBy?: string;
};

export type JobGate = {
  readonly class: GateClass;
  readonly steps?: Readonly<Record<string, StepGate>>;
};

/** GitHub expression that is true only in merge-group runs. */
const MERGE_GROUP_ONLY = ["$", "{{ github.event_name == 'merge_group' }}"].join(
  "",
);

/** `continue-on-error` value a listed step must carry for its class. */
export const CONTINUE_ON_ERROR: Readonly<
  Record<Exclude<GateClass, "correctness">, string | boolean>
> = {
  advisory: true,
  budget: MERGE_GROUP_ONLY,
  "time-based": MERGE_GROUP_ONLY,
};

/**
 * Steps named "baseline", "budget" or "coverage" that are nonetheless
 * correctness guards: two passing changes can combine into a defect, so they
 * block merge groups too and may never be classed or softened.
 */
export const CORRECTNESS_GUARDS: Readonly<Record<string, string>> = {
  "Typecheck coverage":
    "Finds source files outside every TypeScript project; one change can add files while another changes project inclusion.",
};

export const CI_GATES: Readonly<Record<string, JobGate>> = {
  "ci-plan": {
    class: "correctness",
    steps: {
      "Login to GitHub Container Registry for image resolution": {
        class: "advisory",
        owner: "ci",
      },
      "Install planner dependencies": {
        class: "advisory",
        owner: "ci",
      },
      "Select changed PR e2e shards": { class: "advisory", owner: "ci" },
    },
  },
  "docker-checks": {
    class: "correctness",
    steps: {
      "Log in to the CI image mirror": { class: "advisory", owner: "ci" },
    },
  },
  "ci-checks-generated": {
    class: "correctness",
    steps: {
      "Typecheck-cost baseline guard": { class: "budget", owner: "ci" },
    },
  },
  "ci-checks-policy": {
    class: "correctness",
    steps: {
      "Ratchet guard": { class: "budget", owner: "code-health" },
      "Knip dead-export budget (all workspaces)": {
        class: "budget",
        owner: "code-health",
      },
    },
  },
  "ci-checks-rest": {
    class: "correctness",
    steps: {
      "Query data state baseline": {
        class: "budget",
        owner: "api-performance",
      },
      "SQL performance baseline": { class: "budget", owner: "api-performance" },
      "Failure-as-empty baseline": { class: "budget", owner: "code-health" },
    },
  },
  "generated-sources": {
    class: "correctness",
    steps: {
      "Save generated sources": { class: "advisory", owner: "ci" },
    },
  },
  "pr-heavy-gate": {
    class: "correctness",
    steps: {
      "dated-waiver-expiry: Check dated waiver expiry on the current tree": {
        class: "time-based",
        owner: "code-health",
        enforcedBy:
          "scripts/dated-waivers.ts scopes expiry failures to pull requests that touch the waiver",
      },
    },
  },
  "ci-tests": { class: "correctness" },
  "api-test-durations": { class: "advisory" },
  "ci-browser": { class: "correctness" },
  "code-quality-api": { class: "correctness" },
  "code-quality-api-cancel": { class: "advisory" },
  "code-quality-web-rest": { class: "correctness" },
  "code-quality-web-rest-cancel": { class: "advisory" },
  "autofix-dispatch": { class: "advisory" },
  "query-perf": { class: "correctness" },
  "postgres-service-suites": { class: "correctness" },
  "service-suites": { class: "correctness" },
  "database-migrations-check": { class: "correctness" },
  "database-migrations-apply-fresh": { class: "correctness" },
  "migration-upgrade-rehearsal": { class: "correctness" },
  "release-typecheck": { class: "correctness" },
  "fix-tests-on-base": {
    class: "correctness",
    steps: {
      "Changed tests fail on the base source": {
        class: "advisory",
        owner: "ci",
      },
    },
  },
  "web-build": { class: "correctness" },
  "web-image-smoke": {
    class: "correctness",
    steps: {
      "Log in to the CI image mirror": { class: "advisory", owner: "ci" },
    },
  },
  "mobile-build": { class: "correctness" },
  "landing-build": { class: "correctness" },
  "heavy-web-build": { class: "correctness" },
  "route-smoke": {
    class: "correctness",
    steps: {
      "Login to GitHub Container Registry for browser images": {
        class: "advisory",
        owner: "ci",
      },
      "Check route network baseline": {
        class: "budget",
        owner: "web-performance",
      },
    },
  },
  "e2e-production-shard": {
    class: "correctness",
    steps: {
      "Login to GitHub Container Registry for browser images": {
        class: "advisory",
        owner: "ci",
      },
      "Check route network baseline": {
        class: "budget",
        owner: "web-performance",
      },
    },
  },
  "stack-redaction-browsers": {
    class: "correctness",
    steps: {
      "Login to GitHub Container Registry for browser images": {
        class: "advisory",
        owner: "ci",
      },
    },
  },
  "e2e-vite-canary": {
    class: "correctness",
    steps: {
      "Login to GitHub Container Registry for browser images": {
        class: "advisory",
        owner: "ci",
      },
    },
  },
  "e2e-landing": {
    class: "correctness",
    steps: {
      "Login to GitHub Container Registry for browser images": {
        class: "advisory",
        owner: "ci",
      },
    },
  },
  "marketing-screenshots": { class: "correctness" },
  "marketing-screenshots-cancel": { class: "advisory" },
  "e2e-report": { class: "advisory" },
  "api-image-smoke": {
    class: "correctness",
    steps: {
      "Log in to the CI image mirror": { class: "advisory", owner: "ci" },
    },
  },
  "legal-atlas-image": {
    class: "correctness",
    steps: {
      "Log in to the CI image mirror": { class: "advisory", owner: "ci" },
    },
  },
  "desktop-windows-dry-run": {
    class: "correctness",
    steps: {
      "Resolve Windows build toolchain": { class: "advisory", owner: "ci" },
      "Look up successful queue dry-run receipt": {
        class: "advisory",
        owner: "ci",
      },
      "Upload successful queue dry-run receipt": {
        class: "advisory",
        owner: "ci",
      },
    },
  },
  "windows-scripts": { class: "correctness" },
  "scan-engine-wasm-drift": { class: "correctness" },
  "desktop-rust-tests": { class: "correctness" },
  "desktop-rust-lint": { class: "correctness" },
  "dependency-audit": { class: "correctness" },
  "dependency-review": { class: "correctness" },
  "dependency-malware": { class: "correctness" },
  "ci-quick-checks": {
    class: "correctness",
    steps: {
      "dated-waiver-expiry: Check dated waiver expiry on the current tree": {
        class: "time-based",
        owner: "code-health",
        enforcedBy:
          "scripts/dated-waivers.ts scopes expiry failures to pull requests that touch the waiver",
      },
    },
  },
  "ci-result": {
    class: "correctness",
    steps: {
      "Write required-jobs record": { class: "advisory", owner: "ci" },
      "Upload required-jobs record": { class: "advisory", owner: "ci" },
    },
  },
};
