#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { requiresMalwareScan } from "./check-standalone-lockfiles";
import { ciBrowserScopePredicate } from "./ci-browser-scope";
import { dependencyScope, type DependencyScope } from "./ci-dependency-scope";
import {
  requiresDesktopBrowser,
  requiresLandingBuild,
  requiresPackageChecks,
} from "./ci-package-scope";
import { routeSmokeAffected } from "./detect-route-smoke-changes";
import { planServiceSuites } from "./detect-service-suite-changes";

const TRUE = "true";
const FALSE = "false";
const BOTH_PLATFORMS =
  '[{"runner":"ubuntu-24.04-arm","platform":"linux/arm64"},{"runner":"ubuntu-latest","platform":"linux/amd64"}]';
const ARM_PLATFORM = '[{"runner":"ubuntu-24.04-arm","platform":"linux/arm64"}]';

export type ChangedFileScopeInput = {
  changedFiles: readonly string[];
  comparisonBase: string;
  scopeUnknown: boolean;
  dependencyScope?: DependencyScope;
  eventName: string;
  suiteDepth: string;
  heavyOnly: boolean;
  prTitle: string;
  versionChangedInHead?: boolean;
  root?: string;
};

export type ChangedFileScope = Record<ScopeOutput, string>;

const bool = String;
const compiledShellPatterns = new Map<string, RegExp>();
const shellPattern = (pattern: string) => {
  const cached = compiledShellPatterns.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  const compiled = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
      .replaceAll("*", ".*")
      .replaceAll("?", ".")}$`,
    // Bash case wildcards match every character, newlines included.
    "su",
  );
  compiledShellPatterns.set(pattern, compiled);
  return compiled;
};
const matches = (file: string, patterns: readonly string[]) =>
  patterns.some((pattern) => shellPattern(pattern).test(file));
const anyMatches = (files: readonly string[], patterns: readonly string[]) =>
  files.some((file) => matches(file, patterns));

const commonE2e = [
  ".github/actions/ci-install/*",
  "scripts/ci-install.ts",
  "scripts/ci-install-store.ts",
  ".github/actions/setup-e2e-stack/*",
  ".github/actions/setup-production-e2e/*",
  ".github/actions/build-e2e-web/*",
  ".github/actions/setup-playwright/*",
  ".github/actions/marketing-capture/*",
  ".github/workflows/ci.yml",
  ".github/workflows/marketing-screenshots.yml",
  "scripts/detect-e2e-changes.sh",
  "bun.lock",
  "package.json",
  "patches/*",
] as const;
const e2eRequired = (
  scope: "core" | "landing" | "pr-core",
  files: readonly string[],
) => {
  if (anyMatches(files, commonE2e)) {
    return true;
  }
  if (scope === "core") {
    return files.some(
      (file) =>
        !matches(file, [
          "apps/web/e2e/marketing/*",
          "apps/web/e2e/playwright.marketing.config.ts",
          "packages/playwright-tools/*",
        ]) &&
        matches(file, [
          ".github/actions/prepare-network-baseline/*",
          "scripts/network-baseline-*",
          "apps/api/*",
          "apps/web/*",
          "packages/*",
          "docker-compose.yml",
        ]),
    );
  }
  if (scope === "landing") {
    return anyMatches(files, [
      "apps/landing/*",
      "packages/playwright-tools/*",
      "packages/ui/*",
      "packages/anonymize-*",
      "packages/locales/*",
    ]);
  }
  return files.some(
    (file) =>
      file.startsWith("apps/web/e2e/") &&
      !file.startsWith("apps/web/e2e/marketing/"),
  );
};

const desktopRustRequired = (files: readonly string[]) =>
  anyMatches(files, [
    "apps/desktop/rust-toolchain.toml",
    "apps/desktop/src-tauri/*",
    "apps/desktop/fixtures/*",
    "apps/desktop/src/i18n/langs/*",
    "apps/desktop/src/activity/preview-apps.json",
    "apps/desktop/src/clipboard/clipboard-types.ts",
    "packages/api-contract/src/desktop-account-policy.json",
    "packages/api-contract/src/desktop-feature-access.json",
    "packages/api-contract/src/desktop-handoff.ts",
    "packages/api-contract/src/desktop-presence-policy.json",
    "packages/api-contract/src/desktop-presence-request.fixture.json",
    "packages/api-contract/src/desktop-edit-file-types.ts",
    "packages/api-contract/src/desktop-registry.ts",
    "packages/api-contract/src/desktop-rpc.gen.ts",
  ]);

const wideScope = (input: ChangedFileScopeInput): Record<string, string> => {
  const full = input.suiteDepth === "full";
  const releaseTypecheck =
    input.heavyOnly &&
    (input.eventName === "schedule" || input.versionChangedInHead === true);
  return {
    api_scope_unknown: bool(input.scopeUnknown),
    changed_files: JSON.stringify(input.changedFiles),
    comparison_base: input.comparisonBase,
    route_smoke_required: bool(
      input.eventName === "pull_request" ||
        input.eventName === "merge_group" ||
        input.heavyOnly,
    ),
    agent_sandbox_docker_required: TRUE,
    api_image_deps_required: TRUE,
    docker_checks_required: TRUE,
    docker_checks_pr_required: TRUE,
    api_image_platforms: BOTH_PLATFORMS,
    api_image_smoke_required: TRUE,
    postgres_suites_required: TRUE,
    corpus_suites_required: TRUE,
    valkey_suites_required: TRUE,
    collaboration_suite_required: TRUE,
    service_suites_pr_required: TRUE,
    collab_redis_required: TRUE,
    desktop_rust_checks_required: TRUE,
    desktop_browser_required: TRUE,
    ci_browser_scope_required: TRUE,
    e2e_core_required: TRUE,
    e2e_production_required: bool(full),
    e2e_landing_required: TRUE,
    fix_tests_on_base_required: FALSE,
    landing_build_required: bool(!full),
    legal_atlas_image_required: TRUE,
    legal_atlas_image_pr_required: TRUE,
    dependency_malware_required: TRUE,
    lockfile_ages_required: FALSE,
    migration_rehearsal_required: TRUE,
    mobile_build_required: TRUE,
    model_catalog_drift_required: TRUE,
    package_checks_required: TRUE,
    docs_checks_required: FALSE,
    docs_changed_files: "[]",
    published_exports_required: TRUE,
    release_typecheck_required: bool(releaseTypecheck),
    route_tree_required: TRUE,
    scan_engine_wasm_required: TRUE,
    stack_redaction_browsers_required: TRUE,
    web_api_types_required: TRUE,
    web_build_required: TRUE,
    web_image_smoke_required: TRUE,
    windows_scripts_required: TRUE,
    desktop_windows_dry_run_required: TRUE,
  };
};

const deriveScopeFacts = (input: ChangedFileScopeInput) => {
  if (
    input.eventName === "workflow_dispatch" ||
    input.scopeUnknown ||
    input.heavyOnly
  ) {
    return { type: "override", outputs: wideScope(input) } as const;
  }
  const files = input.changedFiles;
  if (files.length === 0) {
    const api = bool(input.suiteDepth === "full");
    return {
      type: "override",
      outputs: {
        api_scope_unknown: FALSE,
        changed_files: JSON.stringify(files),
        comparison_base: input.comparisonBase,
        agent_sandbox_docker_required: FALSE,
        api_image_deps_required: FALSE,
        docker_checks_required: FALSE,
        docker_checks_pr_required: FALSE,
        api_image_platforms: "[]",
        api_image_smoke_required: FALSE,
        postgres_suites_required: api,
        corpus_suites_required: api,
        valkey_suites_required: api,
        collaboration_suite_required: FALSE,
        service_suites_pr_required: FALSE,
        collab_redis_required: FALSE,
        desktop_rust_checks_required: FALSE,
        desktop_browser_required: FALSE,
        ci_browser_scope_required: FALSE,
        e2e_core_required: FALSE,
        e2e_production_required: FALSE,
        e2e_landing_required: FALSE,
        fix_tests_on_base_required: FALSE,
        landing_build_required: FALSE,
        legal_atlas_image_required: FALSE,
        legal_atlas_image_pr_required: FALSE,
        dependency_malware_required: FALSE,
        lockfile_ages_required: FALSE,
        migration_rehearsal_required: FALSE,
        mobile_build_required: FALSE,
        model_catalog_drift_required: FALSE,
        package_checks_required: TRUE,
        docs_checks_required: FALSE,
        docs_changed_files: "[]",
        published_exports_required: FALSE,
        release_typecheck_required: FALSE,
        route_smoke_required: FALSE,
        route_tree_required: FALSE,
        scan_engine_wasm_required: FALSE,
        stack_redaction_browsers_required: FALSE,
        web_api_types_required: FALSE,
        web_build_required: FALSE,
        web_image_smoke_required: FALSE,
        windows_scripts_required: FALSE,
        desktop_windows_dry_run_required: FALSE,
      },
    } as const;
  }
  return deriveNormalScopeFacts(input, files);
};

const deriveNormalScopeFacts = (
  input: ChangedFileScopeInput,
  files: readonly string[],
) => {
  const root = input.root;
  const resolved = input.dependencyScope;
  const scopeFiles =
    resolved?.type === "dev-tooling" || resolved?.type === "runtime"
      ? resolved.files
      : files;
  const dependencyClass = resolved?.type ?? "none";
  let packageChecks = true;
  if (
    dependencyClass !== "dev-tooling" &&
    ["pull_request", "merge_group"].includes(input.eventName)
  ) {
    packageChecks = requiresPackageChecks({ changed: scopeFiles, root });
  }
  const docs = packageChecks
    ? []
    : files.filter((file) => /\.mdx?$/u.test(file));
  const services = planServiceSuites(scopeFiles, root);
  let desktopBrowser = requiresDesktopBrowser({ changed: scopeFiles, root });
  if (!packageChecks) {
    desktopBrowser = false;
  }
  const full = input.suiteDepth === "full";
  const version = files.includes("VERSION");
  const imageInputs = anyMatches(files, [
    "*/Dockerfile",
    "*.Dockerfile",
    "*/package.json",
    "package.json",
    "bun.lock",
    "bunfig.toml",
    ".npmrc",
    "patches/*",
    "turbo.json",
    "scripts/pull-base-images.sh",
    "scripts/ci-service-images.ts",
    "scripts/ci-service-images.json",
    "apps/legal-atlas-runner/*",
    "packages/legal-atlas/*",
    "packages/agent-engine/docker/*",
    ".dockerignore",
  ]);
  const p = (patterns: readonly string[]) => anyMatches(files, patterns);
  let e2eCore = e2eRequired("core", files);
  const collab = p([
    "apps/collab/*",
    "apps/api/src/handlers/folio-collab/*",
    "apps/api/src/handlers/entities/join-folio-collab-room.ts",
    "apps/api/src/lib/folio-collab-*",
    "apps/api/src/lib/configured-bearer-access*",
    "packages/api-contract/package.json",
    "packages/api-contract/src/folio-collab*",
    "bun.lock",
    ".github/workflows/ci.yml",
  ]);
  if (collab) {
    e2eCore = true;
  }
  const e2eLanding = e2eRequired("landing", files);
  const routeSmoke =
    ["pull_request", "merge_group"].includes(input.eventName) &&
    routeSmokeAffected(scopeFiles, root);
  let webBuild = p([
    "apps/web/*",
    "packages/*",
    "patches/*",
    "scripts/bundle-baseline.ts",
    "scripts/bundle-baseline.json",
    "VERSION",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    ".npmrc",
    ".github/workflows/ci.yml",
  ]);
  if (e2eCore || routeSmoke) {
    webBuild = true;
  }
  let landing =
    input.eventName === "pull_request"
      ? requiresLandingBuild({ changed: scopeFiles, root })
      : p([
          "apps/landing/*",
          "docs/changelog/*",
          "VERSION",
          "packages/*",
          "patches/*",
          "bun.lock",
          "package.json",
          ".github/workflows/ci.yml",
        ]);
  if (full && e2eLanding) {
    landing = false;
  }
  const apiDeps = p([
    "apps/api/*",
    "apps/collab/*",
    "apps/legal-atlas-runner/*",
    "packages/*",
    "patches/*",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    ".npmrc",
    "turbo.json",
    ".github/workflows/ci.yml",
  ]);
  const sandbox = p([
    ".github/workflows/agent-sandbox-canary.yml",
    ".github/workflows/ci.yml",
    "packages/agent-engine/*",
    "package.json",
    "bun.lock",
    "scripts/pull-base-images.sh",
    "scripts/ci-service-images.ts",
    "scripts/ci-service-images.json",
    "scripts/retry.sh",
  ]);
  const legal = p([
    "apps/legal-atlas-runner/*",
    "apps/api/*",
    "apps/*/package.json",
    "packages/*",
    "patches/*",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    ".npmrc",
    "turbo.json",
    "scripts/pull-base-images.sh",
    "scripts/ci-service-images.ts",
    "scripts/ci-service-images.json",
    "scripts/retry.sh",
    "scripts/legal-atlas-image-scope*",
    "scripts/docker-source-closure*",
    "scripts/generated-imports*",
    "scripts/generated-files*",
    "scripts/install-free-ci*",
    ".dockerignore",
    ".github/workflows/ci.yml",
  ]);
  const postgres = full ? packageChecks : services.postgres;
  const corpus = full ? packageChecks : services.corpus;
  const valkey = full ? packageChecks : services.valkey;
  const collaboration = full ? collab : services.collab;
  const servicePr =
    services.postgres || services.corpus || services.valkey || services.collab;
  const fixTest =
    input.eventName === "pull_request" &&
    /^fix(?:\([^)]*\))?!?:\s/u.test(input.prTitle) &&
    p([
      "apps/api/src/*.test.ts",
      "apps/api/src/*.test.tsx",
      "apps/api/evals/*.test.ts",
      "apps/api/evals/*.test.tsx",
      "apps/api/scripts/*.test.ts",
      "apps/api/scripts/*.test.tsx",
    ]);
  return {
    type: "normal",
    input,
    files,
    scopeFiles,
    packageChecks,
    docs,
    services,
    desktopBrowser,
    full,
    version,
    imageInputs,
    p,
    e2eCore,
    collab,
    e2eLanding,
    routeSmoke,
    webBuild,
    landing,
    apiDeps,
    sandbox,
    legal,
    postgres,
    corpus,
    valkey,
    collaboration,
    servicePr,
    fixTest,
  } as const;
};

const OUTPUT_ORDER = [
  "api_scope_unknown",
  "changed_files",
  "comparison_base",
  "agent_sandbox_docker_required",
  "api_image_deps_required",
  "docker_checks_required",
  "docker_checks_pr_required",
  "api_image_platforms",
  "api_image_smoke_required",
  "postgres_suites_required",
  "corpus_suites_required",
  "valkey_suites_required",
  "collaboration_suite_required",
  "service_suites_pr_required",
  "collab_redis_required",
  "desktop_rust_checks_required",
  "desktop_browser_required",
  "ci_browser_scope_required",
  "e2e_core_required",
  "e2e_production_required",
  "e2e_landing_required",
  "fix_tests_on_base_required",
  "landing_build_required",
  "legal_atlas_image_required",
  "legal_atlas_image_pr_required",
  "dependency_malware_required",
  "lockfile_ages_required",
  "migration_rehearsal_required",
  "mobile_build_required",
  "model_catalog_drift_required",
  "package_checks_required",
  "docs_checks_required",
  "docs_changed_files",
  "published_exports_required",
  "release_typecheck_required",
  "route_smoke_required",
  "route_tree_required",
  "scan_engine_wasm_required",
  "stack_redaction_browsers_required",
  "web_api_types_required",
  "web_build_required",
  "web_image_smoke_required",
  "windows_scripts_required",
  "desktop_windows_dry_run_required",
] as const;

export type ScopeOutput = (typeof OUTPUT_ORDER)[number];
type ScopeFacts = ReturnType<typeof deriveScopeFacts>;
type NormalScopeFacts = Extract<ScopeFacts, { type: "normal" }>;

const scopeRule = (
  facts: ScopeFacts,
  output: ScopeOutput,
  evaluate: (facts: NormalScopeFacts) => string,
) =>
  facts.type === "override" ? (facts.outputs[output] ?? "") : evaluate(facts);

export const OUTPUT_RULES = {
  api_scope_unknown: (facts) =>
    scopeRule(facts, "api_scope_unknown", () => FALSE),
  changed_files: (facts) =>
    scopeRule(facts, "changed_files", ({ files }) => JSON.stringify(files)),
  comparison_base: (facts) =>
    scopeRule(facts, "comparison_base", ({ input }) => input.comparisonBase),
  agent_sandbox_docker_required: (facts) =>
    scopeRule(facts, "agent_sandbox_docker_required", ({ sandbox }) =>
      bool(sandbox),
    ),
  api_image_deps_required: (facts) =>
    scopeRule(facts, "api_image_deps_required", ({ apiDeps }) => bool(apiDeps)),
  docker_checks_required: (facts) =>
    scopeRule(facts, "docker_checks_required", ({ apiDeps, sandbox }) =>
      bool(sandbox || apiDeps),
    ),
  docker_checks_pr_required: (facts) =>
    scopeRule(
      facts,
      "docker_checks_pr_required",
      ({ imageInputs, apiDeps, sandbox }) =>
        bool((sandbox || apiDeps) && imageInputs),
    ),
  api_image_platforms: (facts) =>
    scopeRule(facts, "api_image_platforms", ({ full, version }) =>
      full || version ? BOTH_PLATFORMS : ARM_PLATFORM,
    ),
  api_image_smoke_required: (facts) =>
    scopeRule(facts, "api_image_smoke_required", ({ p }) =>
      bool(
        p([
          "VERSION",
          "apps/api/*",
          "apps/collab/*",
          "apps/legal-atlas-runner/*",
          "packages/*",
          "patches/*",
          "apps/*/package.json",
          "apps/landing/public/fonts/CabinetGrotesk-Regular.otf",
          "docker/postgres/*.sql",
          "docker/postgres/*.conf",
          "scripts/configure-test-postgres.sh",
          ".gitmodules",
          "bun.lock",
          "bunfig.toml",
          "package.json",
          ".npmrc",
          "turbo.json",
          "scripts/ci-install*",
          "scripts/smoke-api-image.sh",
          "scripts/pull-base-images.sh",
          "scripts/ci-service-images.ts",
          "scripts/ci-service-images.json",
          "scripts/retry.sh",
          ".dockerignore",
          ".github/workflows/ci.yml",
          ".github/workflows/release.yml",
        ]),
      ),
    ),
  postgres_suites_required: (facts) =>
    scopeRule(facts, "postgres_suites_required", ({ postgres }) =>
      bool(postgres),
    ),
  corpus_suites_required: (facts) =>
    scopeRule(facts, "corpus_suites_required", ({ corpus }) => bool(corpus)),
  valkey_suites_required: (facts) =>
    scopeRule(facts, "valkey_suites_required", ({ valkey }) => bool(valkey)),
  collaboration_suite_required: (facts) =>
    scopeRule(facts, "collaboration_suite_required", ({ collaboration }) =>
      bool(collaboration),
    ),
  service_suites_pr_required: (facts) =>
    scopeRule(facts, "service_suites_pr_required", ({ servicePr }) =>
      bool(servicePr),
    ),
  collab_redis_required: (facts) =>
    scopeRule(facts, "collab_redis_required", ({ collab }) => bool(collab)),
  desktop_rust_checks_required: (facts) =>
    scopeRule(facts, "desktop_rust_checks_required", ({ files }) =>
      bool(desktopRustRequired(files)),
    ),
  desktop_browser_required: (facts) =>
    scopeRule(facts, "desktop_browser_required", ({ desktopBrowser }) =>
      bool(desktopBrowser),
    ),
  ci_browser_scope_required: (facts) =>
    scopeRule(facts, "ci_browser_scope_required", ({ input, scopeFiles }) =>
      bool(ciBrowserScopePredicate({ root: input.root })(scopeFiles)),
    ),
  e2e_core_required: (facts) =>
    scopeRule(facts, "e2e_core_required", ({ e2eCore }) => bool(e2eCore)),
  e2e_production_required: (facts) =>
    scopeRule(
      facts,
      "e2e_production_required",
      ({ input, files, full, e2eCore }) =>
        bool(
          full
            ? e2eCore
            : input.eventName === "pull_request" &&
                e2eRequired("pr-core", files),
        ),
    ),
  e2e_landing_required: (facts) =>
    scopeRule(facts, "e2e_landing_required", ({ e2eLanding }) =>
      bool(e2eLanding),
    ),
  fix_tests_on_base_required: (facts) =>
    scopeRule(facts, "fix_tests_on_base_required", ({ fixTest }) =>
      bool(fixTest),
    ),
  landing_build_required: (facts) =>
    scopeRule(facts, "landing_build_required", ({ landing }) => bool(landing)),
  legal_atlas_image_required: (facts) =>
    scopeRule(facts, "legal_atlas_image_required", ({ legal }) => bool(legal)),
  legal_atlas_image_pr_required: (facts) =>
    scopeRule(
      facts,
      "legal_atlas_image_pr_required",
      ({ imageInputs, legal }) => bool(legal && imageInputs),
    ),
  dependency_malware_required: (facts) =>
    scopeRule(facts, "dependency_malware_required", ({ files }) =>
      bool(requiresMalwareScan(files)),
    ),
  lockfile_ages_required: (facts) =>
    scopeRule(facts, "lockfile_ages_required", ({ p }) =>
      bool(
        p([
          "bun.lock",
          "*/bun.lock",
          "scripts/check-lockfile-release-ages.ts",
          "scripts/check-lockfile-release-ages.test.ts",
          "scripts/check-stll-quarantine-excludes.ts",
          "scripts/bun-lock-text.ts",
        ]),
      ),
    ),
  migration_rehearsal_required: (facts) =>
    scopeRule(facts, "migration_rehearsal_required", ({ p }) =>
      bool(
        p([
          "VERSION",
          "apps/api/drizzle/*",
          "apps/api/src/db/*",
          "apps/api/src/lib/db/*",
          "apps/api/src/lib/decision-date-bounds-sql.ts",
          "apps/api/src/handlers/case-law/citation-resolution.ts",
          "apps/api/src/scripts/*",
          "scripts/rehearse-migration-upgrade.sh",
          "scripts/resolve-promoted-release.ts",
          "scripts/migration-rehearsal-db.ts",
          ".github/workflows/ci.yml",
        ]),
      ),
    ),
  mobile_build_required: (facts) =>
    scopeRule(facts, "mobile_build_required", ({ p }) =>
      bool(
        p([
          "apps/mobile/*",
          "packages/*",
          "patches/*",
          "bun.lock",
          "bunfig.toml",
          "package.json",
          ".npmrc",
          ".github/workflows/ci.yml",
        ]),
      ),
    ),
  model_catalog_drift_required: (facts) =>
    scopeRule(facts, "model_catalog_drift_required", ({ p }) =>
      bool(
        p([
          ".github/workflows/ci.yml",
          "packages/ai-catalog/package.json",
          "packages/ai-catalog/src/capabilities-overrides.ts",
          "packages/ai-catalog/src/capabilities.gen.ts",
          "packages/ai-catalog/src/document-input-overrides.ts",
          "packages/ai-catalog/src/index.ts",
          "packages/ai-catalog/src/model-rate-policy.ts",
          "packages/ai-catalog/src/model-rate.ts",
          "packages/ai-catalog/src/model-rates.gen.ts",
          "packages/scripts/src/model-catalog-capabilities-gen.ts",
          "packages/scripts/src/model-catalog-capabilities.ts",
          "packages/scripts/src/model-catalog-rates-gen.ts",
        ]),
      ),
    ),
  package_checks_required: (facts) =>
    scopeRule(facts, "package_checks_required", ({ packageChecks }) =>
      bool(packageChecks),
    ),
  docs_checks_required: (facts) =>
    scopeRule(facts, "docs_checks_required", ({ docs }) =>
      bool(docs.length > 0),
    ),
  docs_changed_files: (facts) =>
    scopeRule(facts, "docs_changed_files", ({ docs }) => JSON.stringify(docs)),
  published_exports_required: (facts) =>
    scopeRule(facts, "published_exports_required", ({ full, p }) =>
      bool(
        full ||
          p([
            "packages/*",
            "patches/*",
            "scripts/check-published-exports.ts",
            "scripts/prepare-publish.ts",
            "scripts/publish-manifest.ts",
            "scripts/published-export-guards.ts",
            "bun.lock",
            "bunfig.toml",
            "package.json",
            ".npmrc",
            ".github/workflows/ci.yml",
          ]),
      ),
    ),
  release_typecheck_required: (facts) =>
    scopeRule(facts, "release_typecheck_required", ({ version }) =>
      bool(version),
    ),
  route_smoke_required: (facts) =>
    scopeRule(facts, "route_smoke_required", ({ routeSmoke }) =>
      bool(routeSmoke),
    ),
  route_tree_required: (facts) =>
    scopeRule(facts, "route_tree_required", ({ full, p }) =>
      bool(
        full ||
          p([
            "apps/web/src/routes/*",
            "apps/web/vite.config.ts",
            "apps/web/route-tree.config.ts",
            "apps/web/scripts/generate-route-tree.ts",
            "apps/web/package.json",
            "apps/web/src/routeTree.gen.ts",
            "packages/scripts/src/prepared-generated-sources.ts",
            "packages/scripts/src/generated-input-identity.ts",
            "packages/scripts/src/generated-files.ts",
            "scripts/generated-files.ts",
            "bun.lock",
          ]),
      ),
    ),
  scan_engine_wasm_required: (facts) =>
    scopeRule(facts, "scan_engine_wasm_required", ({ p }) =>
      bool(
        p(["packages/scan-engine/*", "bun.lock", ".github/workflows/ci.yml"]),
      ),
    ),
  stack_redaction_browsers_required: (facts) =>
    scopeRule(facts, "stack_redaction_browsers_required", ({ p }) =>
      bool(
        p([
          "apps/web/src/lib/analytics/posthog.ts",
          "apps/web/src/lib/analytics/stack-redaction.ts",
          "apps/web/src/lib/analytics/error-diagnostics.ts",
          "apps/web/e2e/stack-redaction/*",
          "apps/web/e2e/playwright.stack-redaction.config.ts",
          "apps/web/e2e/tsconfig.json",
          "apps/web/tsconfig.json",
          "apps/web/package.json",
          "scripts/retry.sh",
          ".github/actions/setup-playwright/*",
          "bunfig.toml",
          "package.json",
          "bun.lock",
          ".npmrc",
          ".github/workflows/ci.yml",
        ]),
      ),
    ),
  web_api_types_required: (facts) =>
    scopeRule(facts, "web_api_types_required", ({ full, p }) =>
      bool(
        full ||
          p([
            "apps/api/*",
            "apps/web/src/*",
            "apps/web/package.json",
            "apps/web/tsconfig*.json",
            "packages/*",
            "scripts/generated-files.ts",
            "patches/*",
            "types/*",
            "tsconfig*.json",
            "bun.lock",
            "bunfig.toml",
            "package.json",
            ".npmrc",
            "turbo.json",
            ".github/workflows/ci.yml",
          ]),
      ),
    ),
  web_build_required: (facts) =>
    scopeRule(facts, "web_build_required", ({ webBuild }) => bool(webBuild)),
  web_image_smoke_required: (facts) =>
    scopeRule(facts, "web_image_smoke_required", ({ p }) =>
      bool(
        p([
          "VERSION",
          "apps/web/Dockerfile",
          "apps/web/src/runtime.ts",
          "apps/web/vite.config.ts",
          "packages/start-runtime/**",
          "packages/*/package.json",
          "scripts/stage-web-runtime.ts",
          "scripts/publish-manifest.ts",
          "scripts/web-runtime-closure.ts",
          "scripts/pull-base-images.sh",
          "scripts/ci-service-images.ts",
          "scripts/ci-service-images.json",
          "scripts/retry.sh",
          "bun.lock",
          ".dockerignore",
          ".github/workflows/ci.yml",
        ]),
      ),
    ),
  windows_scripts_required: (facts) =>
    scopeRule(facts, "windows_scripts_required", ({ p }) =>
      bool(
        p([
          "packages/scripts/*",
          "scripts/ci-install*.ts",
          "package.json",
          "bun.lock",
          ".github/workflows/ci.yml",
        ]),
      ),
    ),
  desktop_windows_dry_run_required: (facts) =>
    scopeRule(facts, "desktop_windows_dry_run_required", ({ files }) =>
      bool(
        files.some(
          (file) =>
            !/\.mdx?$/u.test(file) &&
            matches(file, [
              "apps/desktop/*",
              "scripts/desktop-*",
              "scripts/*tauri*",
              "scripts/detect-desktop-*",
              "scripts/check-desktop-*",
              "scripts/ci-windows-dry-run-*",
              "scripts/wasm-*",
              "scripts/test-wasm-offline.sh",
              "scripts/run-oxfmt.ts",
              "scripts/check-format-environment.ts",
              "scripts/ci-install*",
              "scripts/build-updater-manifest.sh",
              "scripts/promote-desktop-release.sh",
              "scripts/release-channel.sh",
              "scripts/rename-desktop-artifacts.sh",
              "scripts/check-api-deployment.ts",
              "scripts/gh-retry.sh",
              "scripts/retry.sh",
              "scripts/build-desktop-dmg.sh",
              ".github/actions/desktop-windows-build/*",
              ".github/workflows/release-desktop.yml",
              ".github/workflows/ci.yml",
              "package.json",
              "bun.lock",
            ]),
        ),
      ),
    ),
} as const satisfies Record<ScopeOutput, (facts: ScopeFacts) => string>;

export const computeChangedFileScope = (input: ChangedFileScopeInput) => {
  const facts = deriveScopeFacts(input);
  return Object.fromEntries(
    OUTPUT_ORDER.map((output) => [output, OUTPUT_RULES[output](facts)]),
  ) as Record<ScopeOutput, string>;
};

export const scopeOutputLines = (scope: ChangedFileScope) =>
  OUTPUT_ORDER.map((name) => `${name}=${scope[name]}`);

const git = (args: readonly string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "inherit",
  });
  return result.exitCode === 0 ? result.stdout : undefined;
};

if (import.meta.main) {
  const eventName = Bun.env["EVENT_NAME"] ?? "";
  const heavyOnly = (Bun.env["HEAVY_ONLY"] ?? "false") === TRUE;
  let comparisonBase = "";
  let scopeUnknown = false;
  let changedFiles: string[] = [];
  const baseRef =
    Bun.env["BASE_SHA"] || `origin/${Bun.env["BASE_REF"] ?? "main"}`;
  if (eventName !== "workflow_dispatch" && !heavyOnly) {
    const mergeBase = git(["merge-base", baseRef, "HEAD"]);
    if (mergeBase === undefined) {
      scopeUnknown = true;
    } else {
      comparisonBase = mergeBase.toString().trim();
      const diff = git([
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        comparisonBase,
        "HEAD",
      ]);
      if (diff === undefined) {
        scopeUnknown = true;
      } else {
        changedFiles = diff.toString().split("\0").filter(Boolean);
      }
    }
  }
  const runnerTemp = Bun.env["RUNNER_TEMP"] ?? ".";
  mkdirSync(runnerTemp, { recursive: true });
  writeFileSync(
    path.join(runnerTemp, "api-test-changed-paths"),
    changedFiles.length === 0 ? "" : `${changedFiles.join("\0")}\0`,
  );
  const resolved =
    changedFiles.length === 0
      ? undefined
      : dependencyScope({ base: baseRef, head: "HEAD", changed: changedFiles });
  const versionChangedInHead =
    heavyOnly &&
    git(["diff", "--quiet", "HEAD^", "HEAD", "--", "VERSION"]) === undefined;
  const scope = computeChangedFileScope({
    changedFiles,
    comparisonBase,
    scopeUnknown,
    dependencyScope: resolved,
    eventName,
    suiteDepth: Bun.env["SUITE_DEPTH"] ?? "",
    heavyOnly,
    prTitle: Bun.env["PR_TITLE"] ?? "",
    versionChangedInHead,
  });
  const output = `${scopeOutputLines(scope).join("\n")}\n`;
  if (Bun.env["GITHUB_OUTPUT"]) {
    await Bun.write(Bun.file(Bun.env["GITHUB_OUTPUT"]), output);
  } else {
    process.stdout.write(output);
  }
}
