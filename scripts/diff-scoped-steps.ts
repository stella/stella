// Every CI step that reads a base revision, and why reading only the change is
// enough for it. A check that inspects only changed files can pass a change
// that breaks an unchanged file, and on main (where the base is the checked
// tree) it inspects nothing; each step therefore carries an explicit decision,
// and the census test fails on a step without one.

/** Words in a step's script or env that mean it compares against a base. */
export const DIFF_SCOPE_MARKER =
  /\$\{?(?:BASE_REF|BASE_SHA|RATCHET_BASE_REF|CHECK_BASE_REF|TURBO_SCM_BASE)\b|\.\.\.HEAD|--changed-files|merge-base|base_ref|target_base_sha/u;

export type DiffScopeGap =
  /** Inspects changed files; an unchanged dependent can break unseen. */
  | "dependents"
  /** Outside a pull request or merge group the diff is empty. */
  | "empty-off-change"
  /** The step's condition can never hold for the workflow's triggers. */
  | "never-runs";

export type DiffScope =
  /** The rule is about the change itself (a VERSION bump, new migrations). */
  | { readonly type: "diff-complete"; readonly reason: string }
  /** Scans the whole tree; the base only keeps committed baselines shrinking. */
  | { readonly type: "full-tree"; readonly reason: string }
  /** Widens the change to its dependents before checking. */
  | { readonly type: "expands-dependents"; readonly reason: string }
  /** Resolves, records or reports a base; renders no verdict on content. */
  | { readonly type: "operational"; readonly reason: string }
  /** A known gap; GAP_CEILING bounds how many may exist. */
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

/** Keys are `<workflow file>:<job>#<step name>`. */
export const DIFF_SCOPED_STEPS = {
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
  "autofix.yml:regenerate-derived-files#Restrict autofix changes": diffComplete(
    "Limits the fix to the paths the change touched.",
  ),
  "release.yml:resolve#Verify release source": diffComplete(
    "Checks the provenance of the commits in the release range.",
  ),
  "nightly-test.yml:migration-exact-base-upgrade#Report unavailable rehearsal":
    operational("Reports that no exact base was available."),
  "main-pr-depth.yml:validate#Verify main ancestry": operational(
    "Proves the requested commit is on main.",
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
  "ci.yml:ci-plan#Resolve comparison base": operational(
    "Resolves the base the plan compares against.",
  ),
  "ci.yml:ci-plan#Compute stable patch id": operational(
    "Identifies the change for result reuse.",
  ),
  "ci.yml:ci-plan#Check changed file scope": expands(
    "The plan maps changed files to job scopes, widening through declared inputs.",
  ),
  "ci.yml:pr-heavy-gate#parser-version-guard: Check parser version guard":
    expands(PARSER_VERSIONS),
  "ci.yml:pr-heavy-gate#dated-waiver-expiry: List files the change touches":
    operational("Lists the changed files for the waiver check."),
  "ci.yml:pr-heavy-gate#dated-waiver-expiry: Check dated waiver expiry on the current tree":
    diffComplete(DATED_WAIVER),
  "ci.yml:ci-checks-policy#Compute affected flag": operational(
    "Exports the Turbo comparison base.",
  ),
  "ci.yml:ci-checks-policy#Select measured ratchet base from the target branch":
    operational("Selects the base tree the ratchet measures."),
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
  "ci.yml:ci-checks-rest#Changeset packages match changed files": diffComplete(
    "Concerns the packages the change touches.",
  ),
  "ci.yml:ci-checks-rest#Tauri package alignment": diffComplete(
    "Its trigger covers both lockfiles it reads; when triggered the check is full.",
  ),
  "ci.yml:ci-checks-rest#Lockfile release-age guard": diffComplete(
    "Concerns only pins new against the merge base.",
  ),
  "ci.yml:ci-checks-rest#Test CLI runtime package parity": fullTree(
    "Tests against a real merge base; the verdict covers the packed runtime.",
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
  "ci.yml:ci-checks-rest#Queue authority": fullTree(
    "Full census; the base only keeps the ledger from growing.",
  ),
  "ci.yml:ci-checks-rest#Model task default evidence guard": fullTree(
    "Full census; the base only keeps the ledger from growing.",
  ),
  "ci.yml:ci-checks-rest#Test main heavy workflow contracts": fullTree(
    "Tests the workflow contracts against a real merge base.",
  ),
  "ci.yml:ci-checks-rest#Test CI check partition": fullTree(
    "Compares the full partition with the merge-base declarations.",
  ),
  "ci.yml:ci-checks-rest#Check migration identity against the base branch":
    diffComplete("Concerns the migrations the change adds or removes."),
  "ci.yml:ci-checks-rest#Bridge-version guard": gap(
    "dependents",
    "Watches six bridge files; the other command modules registered by the command manifest can change the bridge without a version bump.",
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
  "ci.yml:service-suites#Select statute recall base from the target branch":
    operational(
      "Selects the baseline file the full recall is measured against.",
    ),
  "ci.yml:database-migrations-check#Check migration coverage": gap(
    "dependents",
    "Treats only the schema entry files as schema changes; table definitions they re-export never mark the schema changed.",
  ),
  "ci.yml:dependency-audit#Audit changed dependency resolutions": diffComplete(
    "Concerns changed resolutions; the scheduled full audit covers unchanged dependencies.",
  ),
  "ci.yml:ci-quick-checks#parser-version-guard: Check parser version guard":
    expands(PARSER_VERSIONS),
  "ci.yml:ci-quick-checks#dated-waiver-expiry: List files the change touches":
    operational("Lists the changed files for the waiver check."),
  "ci.yml:ci-quick-checks#dated-waiver-expiry: Check dated waiver expiry on the current tree":
    diffComplete(DATED_WAIVER),
  "ci.yml:ci-result#Record the certified comparison base": operational(
    "Records the base the verdict was certified against.",
  ),
  "ci.yml:ci-result#Evaluate CI outcome": operational(
    "Aggregates job results for the comparison base.",
  ),
  "dependency-audit.yml:audit#Detect lockfile changes": gap(
    "never-runs",
    "Conditioned on pull_request in a workflow triggered only by push, schedule and dispatch.",
  ),
  "dependency-audit.yml:audit#Audit changed dependency resolutions": gap(
    "never-runs",
    "Conditioned on pull_request in a workflow triggered only by push, schedule and dispatch.",
  ),
} as const satisfies Record<string, DiffScope>;

/**
 * The most known gaps the census allows. Fixing a gap removes its entry and
 * must lower this number, so the list can only shrink.
 */
export const GAP_CEILING = 9;
