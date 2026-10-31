// Every CI step that reads a base revision, and why reading only the change is
// enough for it. A check that inspects only changed files can pass a change
// that breaks an unchanged file, and on main (where the base is the checked
// tree) it inspects nothing; each step therefore carries an explicit decision,
// and the census test fails on a step without one.

import { existsSync, readFileSync } from "node:fs";

/** Names and forms in a step's script, env or inputs that carry a base. */
const STEP_BASE =
  /\b(?:BASE_REF|BASE_SHA|RATCHET_BASE_REF|CHECK_BASE_REF|TURBO_SCM_BASE|GITHUB_BASE_REF|base_ref|base_sha|target_base_sha|base-ref|base-sha)\b|\.\.\.HEAD|--changed-files|merge-base|github\.event\.before|pull_request\.base\.sha|--base\s+["']?(?:HEAD\b|origin\/|[0-9a-f]{40}\b)/u;
/** A script reading a base from the environment, or defaulting to main. */
const SCRIPT_BASE =
  /process\.env(?:\.|\[\s*["'])\w*BASE\w*|\$\{?\w*BASE_(?:REF|SHA)\b|["'`]origin\/main["'`]/u;
const SCRIPT_PATH =
  /(?:^|[\s"'])((?:scripts|apps\/[\w-]+\/scripts|packages\/[\w-]+\/src)\/[\w./-]+\.(?:ts|sh|mjs))/gu;
// Classification labels are prose; a word in them must not decide membership.
const LABEL_ENV = new Set(["CI_CHECK_KIND", "CI_CHECK_CONTEXT"]);

/**
 * Whether a step compares against a base: its script, env (names and values)
 * or action inputs carry one, or a repository script it runs reads one from
 * the environment. Test files a step runs use fixture bases and do not count.
 */
export const readsBaseRevision = (step: Record<string, unknown>): boolean => {
  const run = typeof step["run"] === "string" ? step["run"] : "";
  const env = step["env"];
  const envText =
    typeof env === "object" && env !== null
      ? Object.entries(env)
          .filter(([name]) => !LABEL_ENV.has(name))
          .map(([name, value]) => `${name}=${String(value)}`)
          .join("\n")
      : "";
  if (
    STEP_BASE.test(`${run}\n${envText}\n${JSON.stringify(step["with"] ?? {})}`)
  ) {
    return true;
  }
  return [...run.matchAll(SCRIPT_PATH)].some(([, file]) => {
    if (file === undefined || file.includes(".test.") || !existsSync(file)) {
      return false;
    }
    return SCRIPT_BASE.test(readFileSync(file, "utf-8"));
  });
};

export type DiffScopeGap =
  /** Inspects changed files; an unchanged dependent can break unseen. */
  | "dependents"
  /** Outside a pull request or merge group the diff is empty. */
  | "empty-off-change";

export type DiffScope =
  /** The rule is about the change itself (a VERSION bump, new migrations). */
  | { readonly type: "diff-complete"; readonly reason: string }
  /** Scans the whole tree; the base only keeps committed baselines shrinking. */
  | { readonly type: "full-tree"; readonly reason: string }
  /** Widens the change to its dependents before checking. */
  | { readonly type: "expands-dependents"; readonly reason: string }
  /** Resolves, records or reports a base, or runs other steps; no verdict. */
  | { readonly type: "operational"; readonly reason: string }
  /** A known gap; the `diff-scope-gaps` ratchet metric counts these. */
  | {
      readonly type: "gap";
      readonly gap: DiffScopeGap;
      readonly reason: string;
    };

const diffComplete = (reason: string) =>
  ({ type: "diff-complete", reason }) as const;
const fullTree = (reason: string) => ({ type: "full-tree", reason }) as const;
const expands = (reason: string) =>
  ({ type: "expands-dependents", reason }) as const;
const operational = (reason: string) =>
  ({ type: "operational", reason }) as const;
const gap = (kind: DiffScopeGap, reason: string) =>
  ({ type: "gap", gap: kind, reason }) as const;

const DATED_WAIVER =
  "An expired waiver fails a change only when the change touches its file; the scheduled healing run checks every waiver.";
const PARSER_VERSIONS =
  "Builds each changed parser's import closure before requiring a version bump.";
const CODE_QUALITY =
  "Workspaces run Turbo's affected scope with reverse dependants; on main the comparison is empty, so only a dispatched run checks everything.";
const RESULT_CONSUMPTION =
  "Checks changed files and every module importing them; outside a pull request or merge group it scans every file.";
const CHECK_POOL =
  "Runs the pooled checks, each listed here under its own name.";
const JOB_CLASSIFICATION =
  "Classifies every job; the base only selects the reviews a change must update.";
const NETWORK_BUDGET =
  "Checks every route; only routes added since the base get an exemption.";
const GENERATED_CONFLICTS =
  "Resolves generated-file conflicts against the main tip; no verdict on content.";

/** Keys are `<workflow file>:<job>#<step name>`. */
export const DIFF_SCOPED_STEPS = {
  "queue-admission.yml:admission#Run deterministic manifest checks":
    operational(CHECK_POOL),
  "queue-admission.yml:admission#Check parser versions":
    expands(PARSER_VERSIONS),
  "queue-admission.yml:admission#Check workflow job classifications":
    fullTree(JOB_CLASSIFICATION),
  "queue-admission.yml:admission#Code quality for changed files": expands(
    "Turbo's affected scope adds reverse dependants of the queued change.",
  ),
  "autofix.yml:dependabot-bun-autofix#Verify trusted autofix sources":
    diffComplete("Verifies the provenance of the commits being fixed."),
  "autofix.yml:dependabot-bun-autofix#Align Tauri counterparts": diffComplete(
    "Aligns the counterpart of each changed Tauri package.",
  ),
  "autofix.yml:dependabot-bun-autofix#Add missing Dependabot changeset":
    diffComplete("Adds a changeset for the packages the update changed."),
  "autofix.yml:dependabot-bun-autofix#Restrict generated changes": diffComplete(
    "Limits the fix to the paths the update changed.",
  ),
  "autofix.yml:regenerate-derived-files#Record changed paths": operational(
    "Records which paths the fixers may touch.",
  ),
  "autofix.yml:regenerate-derived-files#Align Tauri counterparts": diffComplete(
    "Aligns the counterpart of each changed Tauri package.",
  ),
  "autofix.yml:regenerate-derived-files#Prune stale baseline entries":
    operational("Rewrites baselines on the fix branch; no verdict."),
  "autofix.yml:regenerate-derived-files#Restrict autofix changes": diffComplete(
    "Limits the fix to the paths the change touched.",
  ),
  "release.yml:resolve#Verify release source": diffComplete(
    "Checks the provenance of the commits in the release range.",
  ),
  "nightly-test.yml:migration-exact-base-upgrade#Rehearse exact-base migration upgrade":
    fullTree("Rehearses the whole upgrade from the exact base."),
  "nightly-test.yml:migration-exact-base-upgrade#Report unavailable rehearsal":
    operational("Reports that no exact base was available."),
  "codeql.yml:scope#Detect relevant changes": diffComplete(
    "Skips analysis only when the change touches no file CodeQL analyses; a run analyses the whole tree.",
  ),
  "cla.yml:verify-signatures#Verify contributor signatures": diffComplete(
    "Concerns the commits the pull request adds.",
  ),
  "generated-conflicts-publish.yml:publish#Rebuild and verify the merge":
    operational(GENERATED_CONFLICTS),
  "generated-conflicts-publish.yml:publish#Push the merge commit":
    operational(GENERATED_CONFLICTS),
  "generated-conflicts-resolve.yml:resolve#Plan the merge":
    operational(GENERATED_CONFLICTS),
  "generated-conflicts-resolve.yml:resolve#Re-resolve merged lockfile with frozen pins":
    operational(GENERATED_CONFLICTS),
  "generated-conflicts-resolve.yml:resolve#Collect the resolution":
    operational(GENERATED_CONFLICTS),
  "network-baseline-record.yml:record#Seed write mode from the latest published recording":
    operational("Seeds the recorder from the last published recording."),
  "journey-canary.yml:journeys#Check published versions": operational(
    "Compares the published versions with main before the journeys run.",
  ),
  "main-pr-depth.yml:validate#Verify main ancestry": operational(
    "Proves the requested commit is on main.",
  ),
  "merge-group-hold.yml:merge-group-hold#Check out the trusted target-branch resolver":
    operational("Checks out the target branch's base resolver; no verdict."),
  "merge-group-hold.yml:merge-group-hold#Resolve comparison base": operational(
    "Resolves the merge group's comparison base for the hold check.",
  ),
  "merge-group-hold.yml:merge-group-hold#Check out trusted base scripts":
    operational(
      "Checks out the hold check from the resolved base; no verdict.",
    ),
  "merge-group-hold.yml:merge-group-hold#Refuse held pull requests":
    diffComplete(
      "Checks exactly the pull requests between the group's base and head.",
    ),
  "merge-group-hold.yml:dequeue-held-pull-request#Check out trusted base scripts":
    operational(
      "Checks out the hold check from the pull request's base; no verdict.",
    ),
  "merge-group-hold.yml:dequeue-held-pull-request#Restore active hold labels and remove held pull requests from the queue":
    operational(
      "Restores hold labels and dequeues the pull request the event names; no verdict on content.",
    ),
  "main-heavy.yml:validate#Verify main ancestry": operational(
    "Proves the requested commit is on main.",
  ),
  "visual-preview.yml:preview#Select preview changes": gap(
    "dependents",
    "Its path list omits the Playwright runner action and the CI service image inventory the tests use.",
  ),
  "publish-npm.yml:pack#Verify manual package recovery source": diffComplete(
    "Checks that the recovered package source is an ancestor of main.",
  ),
  "publish-npm.yml:pack#Build and pack selected packages": operational(
    "Packs the packages selected for publication.",
  ),
  "deploy-landing.yml:scope#Decide whether the push changes the site": expands(
    "Follows the landing's workspace graph and declared inputs from the pushed range.",
  ),
  "ci.yml:ci-plan#Resolve comparison base": operational(
    "Resolves the base the plan compares against.",
  ),
  "ci.yml:ci-plan#Compute stable patch id": operational(
    "Identifies the change for result reuse.",
  ),
  "ci.yml:ci-plan#Check completed suite depth": operational(
    "Reuses a completed run for the same change.",
  ),
  "ci.yml:ci-plan#Check changed file scope": expands(
    "The plan maps changed files to job scopes, widening through declared inputs.",
  ),
  "ci.yml:ci-plan#Select root check inputs": expands(
    "Maps changed files to root checks through their declared inputs.",
  ),
  "ci.yml:ci-plan#Select affected API test files": expands(
    "Selects API tests through the import graph of the changed files; a graph failure widens the selection.",
  ),
  "ci.yml:pr-heavy-gate#parser-version-guard: Check parser version guard":
    expands(PARSER_VERSIONS),
  "ci.yml:pr-heavy-gate#dated-waiver-expiry: List files the change touches":
    operational("Lists the changed files for the waiver check."),
  "ci.yml:pr-heavy-gate#dated-waiver-expiry: Check dated waiver expiry on the current tree":
    diffComplete(DATED_WAIVER),
  "ci.yml:pr-heavy-gate#Check workflow job classifications":
    fullTree(JOB_CLASSIFICATION),
  "ci.yml:ci-checks-generated#Load merge base measurement": operational(
    "Loads the type-cost measurement of the merge base.",
  ),
  "ci.yml:fix-tests-on-base#Changed tests fail on the base source":
    diffComplete(
      "A fix's changed tests must fail on the source before the fix; the rule is about the change itself.",
    ),
  "ci.yml:ci-checks-policy#Compute affected flag": operational(
    "Exports the Turbo comparison base.",
  ),
  "ci.yml:ci-checks-policy#Select measured ratchet base from the target branch":
    operational("Selects the base tree the ratchet measures."),
  "ci.yml:ci-checks-policy#Run policy checks": operational(CHECK_POOL),
  "ci.yml:ci-checks-policy#Ratchet guard": fullTree(
    "Measures both full trees; the base only supplies the comparison.",
  ),
  "ci.yml:ci-checks-policy#Test subject reachability census": fullTree(
    "Scans the whole tree against a shrink-only baseline.",
  ),
  "ci.yml:ci-checks-policy#Deployment feature guard": fullTree(
    "Scans the whole tree against a shrink-only baseline.",
  ),
  "ci.yml:ci-checks-policy#Processed-field backlog guard": fullTree(
    "Scans the whole tree against a shrink-only baseline.",
  ),
  "ci.yml:ci-checks-policy#CI network step retries and timeouts": fullTree(
    "Scans every workflow; the base only keeps exemptions from growing.",
  ),
  "ci.yml:ci-checks-policy#SHA-256 migration ledger": fullTree(
    "Scans the whole ledger; the base only keeps it from growing.",
  ),
  "ci.yml:ci-checks-policy#Custom lint rule coverage": fullTree(
    "Checks every custom rule; the base is not read.",
  ),
  "ci.yml:ci-checks-policy#Instruction references": fullTree(
    "Checks every instruction reference in the tree.",
  ),
  "ci.yml:ci-checks-rest#Run repository checks": operational(CHECK_POOL),
  "ci.yml:ci-checks-rest#Prepare route network manifest":
    fullTree(NETWORK_BUDGET),
  "ci.yml:ci-checks-rest#Changeset packages match changed files": diffComplete(
    "Concerns the packages the change touches.",
  ),
  "ci.yml:ci-checks-rest#Tauri package alignment": diffComplete(
    "Its trigger covers both lockfiles it reads; when triggered the check is full.",
  ),
  "ci.yml:ci-checks-rest#Lockfile release-age guard": diffComplete(
    "Concerns only pins new against the merge base.",
  ),
  "ci.yml:ci-checks-rest#Release changelog guard": diffComplete(
    "Gated on a VERSION change.",
  ),
  "ci.yml:ci-checks-rest#Release queue history guard": diffComplete(
    "Gated on a VERSION change.",
  ),
  "ci.yml:ci-checks-rest#Release CLI coupling guard": diffComplete(
    "Gated on a VERSION change.",
  ),
  "ci.yml:ci-checks-rest#CLI contract changeset guard": diffComplete(
    "The generated contract files are in the diff; generated drift is checked separately.",
  ),
  "ci.yml:ci-checks-rest#SQL performance suppression summary": diffComplete(
    "Reports suppressions on added lines.",
  ),
  "ci.yml:ci-checks-rest#Release marketing provenance warning": diffComplete(
    "Gated on a VERSION change.",
  ),
  "ci.yml:ci-checks-rest#Query data state baseline": fullTree(
    "Full census; the base only keeps the ledger from growing.",
  ),
  "ci.yml:ci-checks-rest#SQL performance baseline": fullTree(
    "Full census; the base only keeps the ledger from growing.",
  ),
  "ci.yml:ci-checks-rest#Failure-as-empty baseline": fullTree(
    "Full census; the base only keeps the ledger from growing.",
  ),
  "ci.yml:ci-checks-rest#Model task default evidence guard": fullTree(
    "Checks every model default; the base only keeps the exemption ledger from growing.",
  ),
  "ci.yml:ci-checks-rest#Queue authority": fullTree(
    "Full census; the base only keeps the ledger from growing.",
  ),
  "ci.yml:ci-checks-rest#Generated files manifest guard": expands(
    "Widens changed files to the generators whose inputs they reach through the import graph.",
  ),
  "ci.yml:ci-checks-rest#Offline check transport policy": fullTree(
    "Runs the offline checks over the whole tree.",
  ),
  "ci.yml:ci-checks-rest#Offline catalogue pinned-content policy": fullTree(
    "Checks every pinned catalogue entry.",
  ),
  "ci.yml:ci-checks-rest#Check migration identity against the base branch":
    diffComplete("Concerns the migrations the change adds or removes."),
  "ci.yml:ci-checks-rest#Bridge-version guard": expands(
    "Watches the bridge files and every crate module the bridge calls, read from bridge.rs.",
  ),
  "ci.yml:ci-tests#Compute affected flag": expands(
    "Turbo's affected scope with declared root inputs; without a base the whole tree.",
  ),
  "ci.yml:ci-tests#Repeat changed tests": diffComplete(
    "Repeats the changed tests to catch flakes; the full suites run separately.",
  ),
  "ci.yml:ci-browser#Check UI browser test scope": expands(
    "Pull requests use the planner's specs; the merge queue covers every package and app the browser legs load.",
  ),
  "ci.yml:ci-browser#Check extension browser test scope": gap(
    "dependents",
    "Its path list omits workspace packages the extension imports.",
  ),
  "ci.yml:code-quality-api#Code quality": gap("empty-off-change", CODE_QUALITY),
  "ci.yml:code-quality-api#Result consumption": expands(RESULT_CONSUMPTION),
  "ci.yml:code-quality-web-rest#Run independent code-quality checks":
    operational(CHECK_POOL),
  "ci.yml:code-quality-web-rest#Code quality (web)": gap(
    "empty-off-change",
    CODE_QUALITY,
  ),
  "ci.yml:code-quality-web-rest#Result consumption (web)":
    expands(RESULT_CONSUMPTION),
  "ci.yml:code-quality-web-rest#Code quality (rest)": gap(
    "empty-off-change",
    CODE_QUALITY,
  ),
  "ci.yml:code-quality-web-rest#Result consumption (rest)":
    expands(RESULT_CONSUMPTION),
  "ci.yml:migration-upgrade-rehearsal#Rehearse the upgrade from the promoted release at scale":
    fullTree("Rehearses the whole upgrade from the promoted release."),
  "ci.yml:service-suites#Select statute recall base from the target branch":
    operational(
      "Selects the baseline file the full recall is measured against.",
    ),
  "ci.yml:database-migrations-check#Check migration coverage": gap(
    "dependents",
    "Treats only the schema entry files as schema changes; table definitions they re-export never mark the schema changed.",
  ),
  "ci.yml:route-smoke#Prepare merge-base network budget":
    fullTree(NETWORK_BUDGET),
  "ci.yml:e2e-production-shard#Prepare merge-base network budget":
    fullTree(NETWORK_BUDGET),
  "ci.yml:dependency-audit#Audit changed dependency resolutions": diffComplete(
    "Concerns changed resolutions; the scheduled full audit covers unchanged dependencies.",
  ),
  "ci.yml:dependency-review#Derive dependency changes": diffComplete(
    "Concerns the dependency diff.",
  ),
  "ci.yml:dependency-review#Dependency Review": diffComplete(
    "Concerns the dependency diff.",
  ),
  "ci.yml:ci-quick-checks#parser-version-guard: Check parser version guard":
    expands(PARSER_VERSIONS),
  "ci.yml:ci-quick-checks#dated-waiver-expiry: List files the change touches":
    operational("Lists the changed files for the waiver check."),
  "ci.yml:ci-quick-checks#dated-waiver-expiry: Check dated waiver expiry on the current tree":
    diffComplete(DATED_WAIVER),
  "ci.yml:ci-quick-checks#Check workflow job classifications":
    fullTree(JOB_CLASSIFICATION),
  "ci.yml:ci-result#Record the certified comparison base": operational(
    "Records the base the verdict was certified against.",
  ),
  "ci.yml:ci-result#Evaluate CI outcome": operational(
    "Aggregates job results for the comparison base.",
  ),
} as const satisfies Record<string, DiffScope>;
