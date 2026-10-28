import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { buildImportGraph } from "./api-test-impact";
import { readSelectionGraph } from "./ci-affected-selection";
import { rootCheckGate } from "./ci-root-check-gate";
import {
  ROOT_CHECK_INPUTS,
  rootCheckInputs,
  selectRootChecks,
  validateRootCheckCensus,
} from "./ci-root-checks";
import { GENERATORS } from "./generated-files";
import { evaluate } from "./github-expression";
import { workflowJobSteps } from "./workflow-steps";

const root = path.resolve(import.meta.dir, "..");
const graph = readSelectionGraph(root);
const inputs = rootCheckInputs(graph);
const dependencyFields = v.record(v.string(), v.string());
const manifestSchema = v.object({
  dependencies: v.optional(dependencyFields, {}),
  devDependencies: v.optional(dependencyFields, {}),
  optionalDependencies: v.optional(dependencyFields, {}),
  peerDependencies: v.optional(dependencyFields, {}),
});
const lockEntrySchema = v.looseObject({
  dependencies: v.optional(dependencyFields, {}),
  optionalDependencies: v.optional(dependencyFields, {}),
  peerDependencies: v.optional(dependencyFields, {}),
});
const lockSchema = v.object({
  packages: v.record(v.string(), v.array(v.unknown())),
});
// Published packages can depend on a workspace package, which the install
// links to the local copy (an app -> npm package -> workspace package path).
const externalDependencies = new Map(
  Object.entries(
    v.parse(
      lockSchema,
      Bun.JSONC.parse(readFileSync(path.join(root, "bun.lock"), "utf-8")),
    ).packages,
  ).map(([key, entry]) => {
    const fields = entry.find((item) => v.is(lockEntrySchema, item));
    if (fields === undefined) {
      return [key, []];
    }
    const { dependencies, optionalDependencies, peerDependencies } = v.parse(
      lockEntrySchema,
      fields,
    );
    return [
      key,
      [dependencies, optionalDependencies, peerDependencies].flatMap((field) =>
        Object.keys(field),
      ),
    ];
  }),
);
const dependencies = new Map([
  ...externalDependencies,
  ...[...graph.packages].map(
    ([name, { directory }]) =>
      [
        name,
        Object.values(
          v.parse(
            manifestSchema,
            JSON.parse(
              readFileSync(path.join(root, directory, "package.json"), "utf-8"),
            ),
          ),
        ).flatMap((field) => Object.keys(field)),
      ] as const,
  ),
]);
const closures = new Map<string, ReadonlySet<string>>();
const closureOf = (consumer: string) => {
  const cached = closures.get(consumer);
  if (cached !== undefined) {
    return cached;
  }
  const visited = new Set<string>();
  const queue = [consumer];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (visited.has(next)) {
      continue;
    }
    visited.add(next);
    queue.push(...(dependencies.get(next) ?? []));
  }
  closures.set(consumer, visited);
  return visited;
};
type ReachesOptions = { consumer: string; dependency: string };
const reaches = ({ consumer, dependency }: ReachesOptions) =>
  closureOf(consumer).has(dependency);

type RootCheckCommand = { check: `${string}/${string}`; files: string[] };

const unsupportedRootCheckCommands = {
  "ci-checks-rest/MCP surface baseline self-test":
    "its production import graph contains runtime-generated MCP modules that Bun cannot resolve statically",
  "ci-checks-rest/Test api scripts":
    "the test target is a shell-expanded glob rather than a static file list",
} as const satisfies Record<string, string>;

const rootCheckCommands = (): RootCheckCommand[] => {
  const source = readFileSync(
    path.join(root, ".github/workflows/ci.yml"),
    "utf-8",
  );
  const workflow: unknown = Bun.YAML.parse(source);
  const commands: RootCheckCommand[] = [];
  const unsupported = new Set<string>();
  for (const [job, checks] of Object.entries(ROOT_CHECK_INPUTS)) {
    const steps = workflowJobSteps(workflow, job);
    for (const [name, declared] of Object.entries(checks)) {
      if (declared.includes("**")) {
        continue;
      }
      const check = `${job}/${name}` as const;
      const runValue = steps.find((candidate) => candidate["name"] === name)?.[
        "run"
      ];
      if (typeof runValue !== "string") {
        continue;
      }
      const run = runValue.trim();
      if (run.includes("\n")) {
        continue;
      }
      const tokens = run.split(/\s+/u);
      const isTest = tokens[0] === "bun" && tokens[1] === "test";
      const entrypoint = tokens[1];
      if (
        !isTest &&
        !(
          tokens[0] === "bun" &&
          /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(entrypoint ?? "")
        )
      ) {
        continue;
      }
      const files = isTest
        ? tokens
            .slice(2)
            .filter((token) => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(token))
        : [entrypoint ?? panic(`Missing Bun entrypoint: ${check}`)];
      if (
        files.some((file) => /[*?[{]/u.test(file)) ||
        Object.hasOwn(unsupportedRootCheckCommands, check)
      ) {
        expect(unsupportedRootCheckCommands).toHaveProperty(check);
        unsupported.add(check);
        continue;
      }
      commands.push({ check, files });
    }
  }
  expect([...unsupported].toSorted()).toEqual(
    Object.keys(unsupportedRootCheckCommands).toSorted(),
  );
  return commands;
};

const inputCoversFile = (file: string, declared: readonly string[]) =>
  declared.some((input) => {
    if (!input.startsWith("@stll/")) {
      return file === input || new Bun.Glob(input).match(file);
    }
    const directory = graph.packages.get(input)?.directory;
    return (
      directory !== undefined &&
      (file === directory || file.startsWith(`${directory}/`))
    );
  });

const ROOT_CHECK_READER_MODULES: Readonly<Record<string, readonly string[]>> = {
  "ci-checks-rest/Test release image CI gate": [
    "apps/api/scripts/api-test-plan.ts",
    "apps/api/scripts/test-file-shards.ts",
    "apps/api/scripts/test-timings.ts",
    "packages/property-testing/src/pinned-seeds.ts",
    "packages/scripts/src/generated-file-inventory.ts",
    "packages/scripts/src/generated-input-identity.ts",
    "scripts/api-test-impact.ts",
    "scripts/check-standalone-lockfiles.ts",
    "scripts/check-stll-quarantine-excludes.ts",
    "scripts/ci-affected-selection.ts",
    "scripts/ci-api-test-plan.ts",
    "scripts/ci-browser-scope.ts",
    "scripts/ci-check-pool-registry.ts",
    "scripts/ci-install-store.ts",
    "scripts/ci-package-scope.ts",
    "scripts/ci-plan-scope.ts",
    "scripts/ci-plan.test.ts",
    "scripts/ci-pr-pilot-plan.ts",
    "scripts/ci-root-checks.ts",
    "scripts/ci-static-checks.ts",
    "scripts/detect-route-smoke-changes.ts",
    "scripts/detect-service-suite-changes.ts",
    "scripts/e2e-spec-shards-core.ts",
    "scripts/generated-files.ts",
    "scripts/install-free-ci.ts",
    "scripts/main-heavy-plan.ts",
    "scripts/production-e2e-inputs.mjs",
    "scripts/run-unlisted-script-tests.ts",
    "scripts/test-input-readers.ts",
    "scripts/test-shards.ts",
  ],
  "ci-checks-rest/Tauri counterpart autofix tests": [
    "scripts/check-tauri-package-alignment.ts",
    "scripts/ci-check-pool-registry.ts",
    "scripts/fix-tauri-package-alignment.ts",
    "scripts/tauri-autofix-workflow.test.ts",
  ],
  "ci-checks-rest/Test oxlint plugins": [
    "oxlint.config.ts",
    "scripts/check-oxlint-rule-coverage.ts",
    "scripts/ci-check-pool-registry.ts",
    "scripts/generated-artifacts.ts",
    "scripts/ownership-loader.ts",
    "scripts/ownership.ts",
    "scripts/oxlint-config-scopes.ts",
    "scripts/oxlint-plugin-test-coverage.test.ts",
    "scripts/oxlint-rule-ids.ts",
    "scripts/result-boundary-globs.ts",
    "scripts/run-custom-lint-tests.ts",
    "scripts/schema-introspection.ts",
  ],
  "ci-checks-rest/Test capability shard merge and package parity": [
    "scripts/capability-shard-merge.test.ts",
    "scripts/capability-shard-pack.test.ts",
    "scripts/changeset-guard.ts",
    "scripts/check-cli-release-coupling.ts",
  ],
  "ci-checks-rest/Lockfile workspace-version guard": [
    "scripts/check-lockfile-workspace-versions.ts",
  ],
  "ci-checks-rest/Resolution range guard": ["scripts/resolution-ranges.ts"],
  "ci-checks-rest/React Compiler bailout guard": ["scripts/rc-bailouts.ts"],
  "ci-checks-rest/Oxlint rule decisions": [
    "oxlint.config.ts",
    "scripts/check-oxlint-rule-decisions.ts",
    "scripts/generated-artifacts.ts",
    "scripts/ownership-loader.ts",
    "scripts/ownership.ts",
    "scripts/oxlint-config-scopes.ts",
    "scripts/oxlint-rule-ids.ts",
    "scripts/result-boundary-globs.ts",
    "scripts/schema-introspection.ts",
  ],
  "ci-checks-rest/Generated source artifact contract": [
    "packages/scripts/src/generated-file-inventory.ts",
    "packages/scripts/src/generated-input-identity.ts",
    "packages/scripts/src/prepared-generated-sources.test.ts",
    "packages/scripts/src/prepared-generated-sources.ts",
    "scripts/ci-check-pool-registry.ts",
    "scripts/ci-generated-sources.test.ts",
    "scripts/generated-files.ts",
    "scripts/install-free-ci.ts",
  ],
  "ci-checks-rest/Windows dry-run receipt contract": [
    "packages/scripts/src/generated-file-inventory.ts",
    "packages/scripts/src/generated-input-identity.ts",
    "packages/scripts/src/prepared-generated-sources.ts",
    "scripts/ci-windows-dry-run-result.test.ts",
    "scripts/ci-windows-dry-run-result.ts",
  ],
  "ci-checks-rest/Test shard partition": [
    "apps/api/scripts/api-test-plan.ts",
    "apps/api/scripts/test-file-shards.ts",
    "apps/api/scripts/test-timings.ts",
    "scripts/api-test-impact.ts",
    "scripts/ci-affected-selection.ts",
    "scripts/ci-api-test-plan.ts",
    "scripts/ci-check-pool-registry.ts",
    "scripts/generated-files.ts",
    "scripts/test-shards.test.ts",
    "scripts/test-shards.ts",
  ],
  "ci-checks-rest/Landing deploy scope": [
    "scripts/generated-files.ts",
    "scripts/landing-deploy-scope.test.ts",
  ],
  "ci-checks-rest/Workflow cache policy": [
    "scripts/ci-check-pool-registry.ts",
    "scripts/ci-install-store.ts",
    "scripts/ci-store-save-policy.ts",
    "scripts/ci-store-save.ts",
    "scripts/main-heavy-plan.ts",
    "scripts/workflow-cache-policy.test.ts",
    "scripts/workflow-concurrency.test.ts",
    "scripts/workflow-run-trust.test.ts",
  ],
  "ci-checks-rest/Store cache save supervisor": [
    "scripts/ci-store-save.test.ts",
    "scripts/ci-store-save.ts",
  ],
  "ci-checks-rest/Module ownership": [
    "scripts/generated-artifacts.ts",
    "scripts/ownership-loader.ts",
    "scripts/ownership.ts",
    "scripts/schema-introspection.ts",
  ],
  "ci-checks-rest/Module ownership invariants": [
    ".oxlint-plugins/__tests__/lint-single-rule.ts",
    "scripts/generated-artifacts.ts",
    "scripts/ownership-loader.ts",
    "scripts/ownership.test.ts",
    "scripts/ownership.ts",
    "scripts/schema-introspection.ts",
  ],
  "ci-checks-rest/Generated artifact formatting invariants": [
    "scripts/generated-artifacts.ts",
  ],
  "ci-checks-rest/Schema introspection invariants": [
    "packages/scripts/src/typescript-program.ts",
    "scripts/generated-artifacts.ts",
    "scripts/outbound-transport-ownership.ts",
    "scripts/ownership-loader.ts",
    "scripts/ownership.ts",
    "scripts/ratchet.ts",
    "scripts/result-boundary-globs.ts",
    "scripts/schema-introspection.test.ts",
    "scripts/schema-introspection.ts",
    "scripts/source-globs.ts",
  ],
  "ci-checks-rest/Design token docs": [
    "scripts/design-tokens-doc.ts",
    "scripts/generated-artifacts.ts",
  ],
  "ci-checks-rest/Test marketing recording verification guard": [
    "scripts/check-marketing-recordings.test.ts",
    "scripts/check-marketing-recordings.ts",
    "scripts/product-media.ts",
  ],
  "ci-checks-rest/Test web container platform boundary": [
    "scripts/check-web-docker-platform.test.ts",
  ],
  "ci-checks-rest/Test @stll resolution pin": [
    "scripts/stll-registry-resolutions.test.ts",
  ],
  "ci-checks-rest/Test web runtime staging": [
    "scripts/stage-web-runtime.test.ts",
    "scripts/stage-web-runtime.ts",
  ],
  "ci-checks-rest/Test published export artifact guard": [
    "scripts/check-published-exports.test.ts",
  ],
  "ci-checks-rest/Test publish manifest transformation": [
    "scripts/publish-manifest.test.ts",
  ],
  "ci-checks-rest/Test main heavy workflow contracts": [
    "scripts/ci-expression-context.ts",
    "scripts/ci-plan-variables.ts",
    "scripts/main-heavy-plan.test.ts",
    "scripts/main-heavy-plan.ts",
    "scripts/main-heavy.test.ts",
    "scripts/validate-main-heavy-sha.test.ts",
  ],
  "ci-checks-rest/Test cancellation evidence": [],
  "ci-checks-rest/Test thin merge queue contracts": [
    "scripts/ci-expression-context.ts",
    "scripts/ci-plan-variables.ts",
    "scripts/main-heavy-plan.ts",
    "scripts/thin-queue.test.ts",
  ],
  "ci-checks-rest/Test dependency malware scanners": [
    "scripts/osv-scanner-install.test.ts",
    "scripts/report-dependency-malware-failure.test.ts",
    "scripts/scan-dependency-malware.test.ts",
  ],
  "ci-checks-rest/Test maintenance release preparation": [
    "packages/property-testing/src/pinned-seeds.ts",
    "scripts/check-marketing-recordings.ts",
    "scripts/prepare-maintenance-release.property.test.ts",
    "scripts/prepare-maintenance-release.ts",
    "scripts/product-media.ts",
  ],
  "ci-checks-rest/Test release queue history guard": [
    "packages/property-testing/src/pinned-seeds.ts",
    "scripts/check-release-queue-history.test.ts",
  ],
  "ci-checks-rest/Test promoted release resolution": [
    "scripts/resolve-promoted-release.test.ts",
    "scripts/resolve-promoted-release.ts",
  ],
  "ci-checks-rest/Test route smoke change detector": [
    "scripts/check-standalone-lockfiles.ts",
    "scripts/check-stll-quarantine-excludes.ts",
    "scripts/ci-browser-scope.ts",
    "scripts/ci-check-pool-registry.ts",
    "scripts/ci-package-scope.ts",
    "scripts/ci-plan-scope.ts",
    "scripts/detect-route-smoke-changes.ts",
    "scripts/detect-service-suite-changes.ts",
    "scripts/generated-files.ts",
    "scripts/install-free-ci.ts",
    "scripts/production-e2e-inputs.mjs",
    "scripts/test-input-readers.ts",
  ],
  "ci-checks-rest/Test changed e2e shard selection": [
    "apps/api/scripts/api-test-plan.ts",
    "apps/api/scripts/test-file-shards.ts",
    "apps/api/scripts/test-timings.ts",
    "scripts/api-test-impact.ts",
    "scripts/ci-check-pool-registry.ts",
    "scripts/detect-route-smoke-changes.ts",
    "scripts/e2e-runner-inputs.ts",
    "scripts/e2e-spec-shards-core.ts",
    "scripts/e2e-spec-shards.test.ts",
  ],
  "ci-checks-rest/Test geometry shard plan": [
    "apps/web/e2e/helpers/docked-chat-hosts.ts",
    "scripts/e2e-geometry-shards.test.ts",
    "scripts/e2e-spec-shards-core.ts",
  ],
  "ci-checks-rest/Test e2e shard budget": [
    "scripts/ci-check-pool-registry.ts",
    "scripts/e2e-shard-budget.test.ts",
    "scripts/e2e-spec-shards-core.ts",
    "scripts/install-free-ci.ts",
  ],
  "ci-checks-rest/Test CI service image workflow contracts": [
    "scripts/ci-service-workflows.test.ts",
  ],
  "ci-checks-rest/Test CI workflow invariants": [
    "packages/scripts/src/generated-file-inventory.ts",
    "packages/scripts/src/generated-input-identity.ts",
    "scripts/autofix-workflow.test.ts",
    "scripts/changeset-guard.ts",
    "scripts/check-base-image-pulls.test.ts",
    "scripts/check-release-upload-retry.test.ts",
    "scripts/check-standalone-lockfiles.ts",
    "scripts/check-stll-quarantine-excludes.ts",
    "scripts/check-tauri-package-alignment.ts",
    "scripts/ci-browser-scope.ts",
    "scripts/ci-check-pool-registry.ts",
    "scripts/ci-install-store.ts",
    "scripts/ci-package-scope.ts",
    "scripts/ci-plan-scope.ts",
    "scripts/ci-static-checks.ts",
    "scripts/dependabot-changeset.test.ts",
    "scripts/dependabot-changeset.ts",
    "scripts/detect-e2e-changes.test.ts",
    "scripts/detect-route-smoke-changes.ts",
    "scripts/detect-service-suite-changes.ts",
    "scripts/generated-files.ts",
    "scripts/install-free-ci.ts",
    "scripts/network-baseline-scope.test.ts",
    "scripts/network-baseline-scope.ts",
    "scripts/production-e2e-inputs.mjs",
    "scripts/test-input-readers.ts",
  ],
  "ci-checks-rest/Test reusable workflow permission contracts": [
    "scripts/workflow-call-permissions.ts",
  ],
  "ci-checks-rest/Test main network recording selection": [
    "scripts/network-baseline-selection.test.ts",
  ],
  "ci-checks-rest/Test API duration workflow": [
    "scripts/api-test-durations-workflow.test.ts",
    "scripts/ci-check-pool-registry.ts",
  ],
  "ci-checks-rest/Test autofix protected paths": [
    "scripts/autofix-protected-paths.test.ts",
    "scripts/autofix-protected-paths.ts",
  ],
  "ci-checks-rest/Test type-aware autofix": [
    "scripts/autofix-type-aware.test.ts",
    "scripts/ci-check-pool-registry.ts",
  ],
  "ci-checks-rest/Test local workflow verification": [
    "scripts/ci-check-pool-registry.ts",
    "scripts/prepare-typecheck-base.test.ts",
    "scripts/verify-admission.ts",
    "scripts/verify-workflow.test.ts",
    "scripts/verify-workflow.ts",
    "scripts/verify.test.ts",
  ],
  "ci-checks-rest/Typecheck cache contract": [
    "packages/scripts/src/api-typecheck-config.ts",
    "packages/scripts/src/api-typecheck-declarations.ts",
    "packages/scripts/src/api-typecheck-inputs.ts",
    "packages/scripts/src/api-typecheck-partition.ts",
    "packages/scripts/src/turbo-typecheck-inputs.ts",
    "packages/scripts/src/typecheck-cache-contract.ts",
    "packages/scripts/src/typescript-program.ts",
    "scripts/typecheck-cache.test.ts",
  ],
  "ci-checks-rest/Test CI check partition": [
    "apps/api/scripts/api-test-plan.ts",
    "apps/api/scripts/test-file-shards.ts",
    "apps/api/scripts/test-timings.ts",
    "packages/property-testing/src/pinned-seeds.ts",
    "packages/scripts/src/generated-file-inventory.ts",
    "packages/scripts/src/generated-input-identity.ts",
    "packages/scripts/src/process-memory.ts",
    "scripts/api-test-impact.ts",
    "scripts/ci-check-pool-registry.ts",
    "scripts/ci-checks-partition.test.ts",
    "scripts/ci-install-store.ts",
    "scripts/ci-static-checks.ts",
    "scripts/generated-files-guard.ts",
    "scripts/generated-files.ts",
    "scripts/oxlint-config-scopes.ts",
    "scripts/run-custom-lint-tests.ts",
  ],
  "ci-checks-rest/Task result cache contract": [
    "scripts/check-test-input-coverage.ts",
    "scripts/task-result-cache.test.ts",
    "scripts/test-input-readers.ts",
  ],
  "ci-checks-rest/Test install-free CI commands": [
    "scripts/ci-check-pool-registry.ts",
    "scripts/ci-install-store.ts",
    "scripts/ci-install.ts",
    "scripts/install-free-ci.test.ts",
    "scripts/install-free-ci.ts",
  ],
  "ci-checks-rest/Test pre-push secret scan ranges": [
    "scripts/check-pushed-secrets.test.ts",
  ],
  "ci-checks-rest/Test merge-base network comparison": [
    "apps/web/e2e/helpers/network.ts",
    "apps/web/scripts/network-baseline-route-tree.ts",
    "scripts/network-baseline-comparison.test.ts",
    "scripts/network-baseline-scope.ts",
  ],
  "ci-checks-rest/Test CLI release coupling gate": [
    "packages/property-testing/src/pinned-seeds.ts",
    "scripts/changeset-guard.ts",
    "scripts/check-cli-release-coupling.test.ts",
    "scripts/check-cli-release-coupling.ts",
    "scripts/ci-check-pool-registry.ts",
  ],
  "ci-checks-rest/Test CLI contract changeset guard": [
    "scripts/changeset-guard.ts",
    "scripts/check-cli-contract-changeset.test.ts",
    "scripts/check-cli-release-coupling.ts",
  ],
  "ci-checks-rest/Test package scaffolder": [
    "scripts/new-package.test.ts",
    "scripts/new-package.ts",
  ],
  "ci-checks-rest/Test changeset guard": [
    "packages/property-testing/src/pinned-seeds.ts",
    "packages/scripts/src/generated-file-inventory.ts",
    "packages/scripts/src/generated-input-identity.ts",
    "scripts/changeset-guard.test.ts",
    "scripts/changeset-guard.ts",
    "scripts/ci-check-pool-registry.ts",
    "scripts/ci-install-store.ts",
    "scripts/ci-static-checks.ts",
  ],
  "ci-checks-rest/Test CI failure digest": [
    "scripts/ci-check-pool-registry.ts",
    "scripts/ci-check-pool.ts",
    "scripts/ci-failure-digest.test.ts",
    "scripts/ci-failure-digest.ts",
  ],
  "ci-checks-rest/Test preview scope tool availability": [
    "scripts/visual-preview-scope.test.ts",
  ],
  "ci-checks-rest/Test public document fetch": [
    "scripts/fetch-public-documents.test.ts",
  ],
  "ci-checks-rest/Test migration identity logic": [
    "scripts/check-migration-order.test.ts",
  ],
  "ci-checks-rest/Check migration identity against the base branch": [],
  "ci-checks-rest/Test dead-columns reference matching": [
    "scripts/check-dead-columns.ts",
  ],
  "ci-checks-rest/Test projection-totality classification": [
    "scripts/check-projection-totality.test.ts",
    "scripts/check-projection-totality.ts",
  ],
  "ci-checks-rest/Test aggregate inventories": [
    "scripts/oxlint-config-scopes.ts",
    "scripts/run-custom-lint-tests.ts",
  ],
  "ci-checks-policy/Processed-field backlog guard": [
    "apps/api/scripts/processed-field-backlog-guard.ts",
  ],
  "ci-checks-policy/Sparse checkout script dependencies": [
    "scripts/sparse-checkout-dependencies.test.ts",
  ],
  "ci-checks-policy/Dependabot group guard (installed packages)": [
    "scripts/dependabot-grouping.test.ts",
  ],
};

// Forward oracle: source owners produced by derived generators, then the
// actual manifest dependency closures of each check's consuming package.
const derivedFiles = (file: string) => {
  const files = new Set([file]);
  for (let previous = -1; previous !== files.size;) {
    previous = files.size;
    for (const generator of GENERATORS) {
      if (generator.outputKind !== "derived") {
        continue;
      }
      if (
        [...files].some((changed) =>
          generator.inputs.some((glob) => new Bun.Glob(glob).match(changed)),
        )
      ) {
        for (const output of generator.outputs) {
          files.add(output);
        }
      }
    }
  }
  return [...files];
};
const seedsForFiles = (files: readonly string[]) =>
  [...graph.packages]
    .filter(([, { directory }]) =>
      files.some((changed) => changed.startsWith(`${directory}/`)),
    )
    .map(([name]) => name);

const assertEnumeration = (table = inputs) => {
  for (const [name, { directory }] of graph.packages) {
    const file = `${directory}/src/probe.ts`;
    const files = derivedFiles(file);
    const seeds = seedsForFiles(files);
    const selected = new Set(
      selectRootChecks({
        changed: [file],
        graph,
        pathChange: "content",
        inputs: table,
      }),
    );
    for (const [check, paths] of inputs) {
      const expected = paths.some(
        (input) =>
          input === "**" ||
          (input.startsWith("@stll/")
            ? seeds.some((dependency) =>
                reaches({ consumer: input, dependency }),
              )
            : files.some((derived) => new Bun.Glob(input).match(derived))),
      );
      expect(selected.has(check), `${name} -> ${check}`).toBe(expected);
    }
  }
};

test("every package selects exactly the root checks reached by its declared source inputs", () =>
  assertEnumeration());

test("the root enumeration fails for a planted missing API reader edge", () => {
  const broken = new Map(inputs);
  const key = "ci-checks-policy/Processed-field backlog guard";
  const paths = broken.get(key) ?? panic("Missing backlog declaration");
  expect(paths).toContain("@stll/api");
  broken.set(
    key,
    paths.filter((input) => input !== "@stll/api"),
  );
  expect(() => assertEnumeration(broken)).toThrow(`@stll/api -> ${key}`);
});

test("all root workflow commands have declarations and narrow gates use the same owner", () => {
  const source = readFileSync(
    path.join(root, ".github/workflows/ci.yml"),
    "utf-8",
  );
  validateRootCheckCensus(source);
  const workflow: unknown = Bun.YAML.parse(source);
  for (const [job, checks] of Object.entries(ROOT_CHECK_INPUTS)) {
    // Pooled checks are steps of their job; see scripts/workflow-steps.ts.
    const steps = workflowJobSteps(workflow, job);
    for (const [name, paths] of Object.entries(checks)) {
      if (paths.includes("**")) {
        continue;
      }
      const step = steps.find((candidate) => candidate["name"] === name);
      expect(String(step?.["if"])).toContain(rootCheckGate({ job, name }));
    }
  }
  const broken = structuredClone(ROOT_CHECK_INPUTS);
  delete broken["ci-checks-policy"]["Processed-field backlog guard"];
  expect(() => validateRootCheckCensus(source, broken)).toThrow(
    "Root check input census differs",
  );
});

test("steps whose success or outputs later steps consume cannot be deselected", () => {
  const source = readFileSync(
    path.join(root, ".github/workflows/ci.yml"),
    "utf-8",
  );
  const job = "ci-checks-rest";
  const name = "Tauri package alignment";
  const id = "id: tauri_alignment\n        if: ${{ !cancelled()";
  expect(source).toContain(id);
  const broken = structuredClone(ROOT_CHECK_INPUTS);
  broken[job][name] = ["@stll/unrelated"];
  expect(() =>
    validateRootCheckCensus(
      source.replace(id, () => `${id} && ${rootCheckGate({ job, name })}`),
      broken,
    ),
  ).toThrow(`Root check gate skips a consumed step: ${job}/${name}`);
});

test("global configuration and structural path changes retain full root scope", () => {
  for (const changed of [
    ["bun.lock"],
    [".github/workflows/ci.yml"],
    ["scripts/ci-root-checks.ts"],
    ["apps/api/scripts/new.ts"],
    ["packages/scripts/src/child-exit-status.ts"],
    ["packages/property-testing/src/index.ts"],
    ["packages/portable-path/src/index.ts"],
  ]) {
    const options = { changed, graph, pathChange: "content" } as const;
    expect(selectRootChecks(options)).toHaveLength(inputs.size);
  }
  const structural = {
    changed: ["apps/landing/src/new.ts"],
    graph,
    pathChange: "structure",
  } as const;
  expect(selectRootChecks(structural)).toHaveLength(inputs.size);
});

test("leaf, core and merge-batch changes preserve the union over the same selector", () => {
  const files = ["apps/landing/src/page.ts", "packages/sha256/src/hash.ts"];
  const options = { graph, pathChange: "content" } as const;
  const leaf = selectRootChecks({ ...options, changed: files.slice(0, 1) });
  expect(leaf).not.toContain("ci-checks-policy/Processed-field backlog guard");
  const core = selectRootChecks({ ...options, changed: files.slice(1) });
  expect(core).toContain("ci-checks-policy/Processed-field backlog guard");
  const union = [...new Set([...leaf, ...core])].toSorted();
  expect(selectRootChecks({ ...options, changed: files }).toSorted()).toEqual(
    union,
  );
});

test("i18n scopes derive every live workspace participant", () => {
  const participants = [...graph.packages]
    .filter(([, owner]) => owner.scripts["i18n:check"] !== undefined)
    .map(([name]) => name);
  const declared =
    inputs.get("ci-checks-rest/Check i18n sync") ?? panic("Missing i18n check");
  for (const name of participants) {
    expect(declared).toContain(name);
  }
  expect(participants).toContain("@stll/transactional");
});

test("workflow gates honor selection and retain all checks when planning is unavailable", () => {
  const selected = selectRootChecks({
    changed: ["apps/landing/src/probe.ts"],
    graph,
    pathChange: "content",
  });
  for (const [job, checks] of Object.entries(ROOT_CHECK_INPUTS)) {
    for (const name of Object.keys(checks)) {
      const gate = rootCheckGate({ job, name });
      for (const output of ["", JSON.stringify(selected)]) {
        expect(
          evaluate(gate, {
            values: { "needs.ci-plan.outputs.root_checks": output },
          }),
        ).toBe(output === "" || selected.includes(`${job}/${name}`));
      }
    }
  }
});

test("narrow Bun root checks declare their static module closure and file readers", () => {
  const effectiveInputs = rootCheckInputs(graph);
  const analyzed = rootCheckCommands();
  expect(analyzed.map(({ check }): string => check).toSorted()).toEqual(
    Object.keys(ROOT_CHECK_READER_MODULES).toSorted(),
  );
  for (const { check, files } of analyzed) {
    const importGraph = buildImportGraph(root, files);
    const closure = new Set(
      files.flatMap((file) => [...importGraph.closure(file)]),
    );
    expect([...importGraph.failed], check).toEqual([]);
    const declared =
      effectiveInputs.get(check) ??
      panic(`Missing root check inputs: ${check}`);
    const uncovered = [...closure]
      .filter((file) => !inputCoversFile(file, declared))
      .toSorted();
    expect(uncovered, `${check} has uncovered imported modules`).toEqual([]);
    const readers = [...closure]
      .filter(
        (file) =>
          importGraph.readers.has(file) || importGraph.scanners.has(file),
      )
      .toSorted();
    expect(readers, `${check} has an unacknowledged file reader`).toEqual(
      [...(ROOT_CHECK_READER_MODULES[check] ?? [])].toSorted(),
    );
  }
});

test("the release image gate module census detects a missing closure input", () => {
  const check = "ci-checks-rest/Test release image CI gate";
  const broken = new Map(rootCheckInputs(graph));
  const declared = broken.get(check) ?? panic("Missing release image gate");
  broken.set(
    check,
    declared.filter((input) => input !== "scripts/**"),
  );
  const importGraph = buildImportGraph(root, ["scripts/ci-plan.test.ts"]);
  const uncovered = [...importGraph.closure("scripts/ci-plan.test.ts")].filter(
    (file) => !inputCoversFile(file, broken.get(check) ?? []),
  );
  expect(uncovered).toContain("scripts/ci-plan.test.ts");
});

test("the release image gate ignores changelog entries and follows CI plan changes", () => {
  const check = "ci-checks-rest/Test release image CI gate";
  const options = { graph, pathChange: "content" } as const;
  expect(
    selectRootChecks({ ...options, changed: ["docs/changelog/example.md"] }),
  ).not.toContain(check);
  expect(
    selectRootChecks({ ...options, changed: ["scripts/ci-plan.ts"] }),
  ).toContain(check);
});

test("derived capability inputs retain API readers and shell bodies retain lockfile validation", () => {
  const isolated = {
    ...graph,
    packages: new Map(
      [...graph.packages].map(([name, owner]) => [
        name,
        { ...owner, dependencies: new Set<string>() },
      ]),
    ),
  };
  for (const { file, check } of [
    {
      file: "packages/cli/capabilities/probe.json",
      check: "ci-checks-policy/Processed-field backlog guard",
    },
    {
      file: "packages/sha256/install.sh",
      check: "ci-checks-rest/Standalone lockfile guard",
    },
  ]) {
    expect(
      selectRootChecks({
        changed: [file],
        graph: isolated,
        pathChange: "content",
      }),
    ).toContain(check);
  }
});
