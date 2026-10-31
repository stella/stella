import type { ScopeOutput } from "./ci-plan-scope";

export type PlanScopeOutput =
  | ScopeOutput
  | "ci_browser_required"
  | "web_build_pr_required"
  | "heavy_web_build_required"
  | "ci_tests_required"
  | "query_perf_required"
  | "postgres_service_suites_required"
  | "service_suites_required"
  | "marketing_screenshots_required"
  | "run_required";

export type PrIndependentReason =
  | "plans-only"
  | "reports-dependent-failures"
  | "cancels-failed-work"
  | "aggregates-job-results";

export type BaseDriftReason = "current-base-i18n-inputs";

export type PrCoverage =
  | {
      type: "runs-on-pr";
      scopeOutput: PlanScopeOutput;
      coupling?: { type: "base-drift"; reason: BaseDriftReason };
    }
  | { type: "pr-independent"; reason: PrIndependentReason };

// This union is reviewed as the merge-group surface. The census test derives the
// live surface from ci.yml and requires exact equality, so either side drifting
// fails rather than silently dropping a job from review.
export type MergeGroupJob =
  | "ci-plan"
  | "generated-sources"
  | "docker-checks"
  | "ci-checks-generated"
  | "ci-checks-policy"
  | "ci-checks-rest"
  | "ci-tests"
  | "ci-browser"
  | "code-quality-api"
  | "code-quality-web-rest"
  | "query-perf"
  | "postgres-service-suites"
  | "service-suites"
  | "database-migrations-check"
  | "database-migrations-apply-fresh"
  | "migration-upgrade-rehearsal"
  | "release-typecheck"
  | "web-build"
  | "web-image-smoke"
  | "mobile-build"
  | "landing-build"
  | "heavy-web-build"
  | "route-smoke"
  | "e2e-production-shard"
  | "stack-redaction-browsers"
  | "e2e-vite-canary"
  | "e2e-landing"
  | "marketing-screenshots"
  | "marketing-screenshots-cancel"
  | "e2e-report"
  | "api-image-smoke"
  | "legal-atlas-image"
  | "desktop-windows-dry-run"
  | "windows-scripts"
  | "scan-engine-wasm-drift"
  | "desktop-rust-tests"
  | "desktop-rust-lint"
  | "dependency-audit"
  | "dependency-review"
  | "dependency-malware"
  | "ci-quick-checks"
  | "ci-result";

const runs = (scopeOutput: PlanScopeOutput): PrCoverage => ({
  type: "runs-on-pr",
  scopeOutput,
});

export const MERGE_GROUP_PR_COVERAGE = {
  "ci-plan": { type: "pr-independent", reason: "plans-only" },
  "generated-sources": runs("package_checks_required"),
  "docker-checks": runs("docker_checks_required"),
  "ci-checks-generated": runs("package_checks_required"),
  "ci-checks-policy": runs("package_checks_required"),
  "ci-checks-rest": {
    type: "runs-on-pr",
    scopeOutput: "package_checks_required",
    coupling: { type: "base-drift", reason: "current-base-i18n-inputs" },
  },
  "ci-tests": runs("ci_tests_required"),
  "ci-browser": runs("ci_browser_required"),
  "code-quality-api": runs("package_checks_required"),
  "code-quality-web-rest": runs("package_checks_required"),
  "query-perf": runs("query_perf_required"),
  "postgres-service-suites": runs("postgres_service_suites_required"),
  "service-suites": runs("service_suites_required"),
  "database-migrations-check": runs("database_migrations_required"),
  "database-migrations-apply-fresh": runs("database_migrations_required"),
  "migration-upgrade-rehearsal": runs("migration_rehearsal_required"),
  "release-typecheck": runs("release_typecheck_required"),
  "web-build": runs("web_build_pr_required"),
  "web-image-smoke": runs("web_image_smoke_required"),
  "mobile-build": runs("mobile_build_required"),
  "landing-build": runs("landing_build_required"),
  "heavy-web-build": runs("heavy_web_build_required"),
  "route-smoke": runs("route_smoke_required"),
  "e2e-production-shard": runs("e2e_production_required"),
  "stack-redaction-browsers": runs("stack_redaction_browsers_required"),
  "e2e-vite-canary": runs("e2e_core_required"),
  "e2e-landing": runs("e2e_landing_required"),
  "marketing-screenshots": runs("marketing_screenshots_required"),
  "marketing-screenshots-cancel": {
    type: "pr-independent",
    reason: "cancels-failed-work",
  },
  "e2e-report": {
    type: "pr-independent",
    reason: "reports-dependent-failures",
  },
  "api-image-smoke": runs("api_image_smoke_required"),
  "legal-atlas-image": runs("legal_atlas_image_required"),
  "desktop-windows-dry-run": runs("desktop_windows_dry_run_required"),
  "windows-scripts": runs("windows_scripts_required"),
  "scan-engine-wasm-drift": runs("scan_engine_wasm_required"),
  "desktop-rust-tests": runs("desktop_rust_checks_required"),
  "desktop-rust-lint": runs("desktop_rust_checks_required"),
  "dependency-audit": runs("dependency_changes_required"),
  "dependency-review": runs("dependency_changes_required"),
  "dependency-malware": runs("dependency_malware_required"),
  "ci-quick-checks": runs("run_required"),
  "ci-result": { type: "pr-independent", reason: "aggregates-job-results" },
} as const satisfies Record<MergeGroupJob, PrCoverage>;

// Existing queue-only gaps are a shrink-only migration inventory. The census
// still requires their intended runs-on-pr decision above and rejects new jobs.
export const PR_COVERAGE_BASELINE = [
  "docker-checks",
  "migration-upgrade-rehearsal",
  "release-typecheck",
  "web-image-smoke",
  "mobile-build",
  "landing-build",
  "heavy-web-build",
  "web-build",
  "e2e-landing",
  "postgres-service-suites",
  "service-suites",
  "route-smoke",
  "stack-redaction-browsers",
  "e2e-vite-canary",
  "marketing-screenshots",
  "api-image-smoke",
  "legal-atlas-image",
  "desktop-windows-dry-run",
  "windows-scripts",
  "ci-quick-checks",
] as const satisfies readonly MergeGroupJob[];
