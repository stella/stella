#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ALL_PACKAGE_ORDER, npmReleaseJobId } from "./publish-packages";

export const NPM_RELEASE_WORKFLOW =
  "stella/.github/.github/workflows/npm-independent-release.yml@5764ab66e4df84cfd2e642c7d7e4678261e668f8";
const START = "  # npm-release-jobs:start";
const END = "  # npm-release-jobs:end";
const SUMMARY_NEEDS = "    # npm-release-summary-needs";
const WORKFLOW_PATH = ".github/workflows/publish-npm.yml";
const EVENT_POLICY_PATH = ".github/ci-event-policy.json";
const RELEASE_EVENT_POLICY = "main";

class NpmReleaseGraphError extends Error {
  override name = "NpmReleaseGraphError";
  readonly _tag = "NpmReleaseGraphError";
}

const panic = (message: string): never => {
  throw new NpmReleaseGraphError(message);
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type NpmReleasePackage = {
  directory: string;
  dependencies: readonly string[];
};

type ReadNpmReleaseGraphOptions = {
  directories?: readonly string[];
  readManifest: (directory: string) => string;
};

export const readNpmReleaseGraph = ({
  directories = ALL_PACKAGE_ORDER,
  readManifest,
}: ReadNpmReleaseGraphOptions): readonly NpmReleasePackage[] => {
  const names = new Map(
    directories.map((directory) => [`@stll/${directory}`, directory]),
  );
  if (
    directories.some((directory) => !/^[a-z0-9][a-z0-9-]*$/u.test(directory))
  ) {
    panic("Invalid directory in npm publishing inventory");
  }
  if (names.size !== directories.length) {
    panic("Duplicate package in npm publishing inventory");
  }
  const graph = directories.map((directory) => {
    const manifest: unknown = JSON.parse(readManifest(directory));
    if (
      !record(manifest) ||
      manifest["name"] !== `@stll/${directory}` ||
      manifest["private"] === true
    ) {
      return panic(`Invalid public manifest for packages/${directory}`);
    }
    const dependencies = new Set<string>();
    for (const group of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const entries = manifest[group];
      if (entries === undefined) {
        continue;
      }
      if (!record(entries)) {
        return panic(`Invalid ${group} for packages/${directory}`);
      }
      for (const dependency of Object.keys(entries)) {
        const target = names.get(dependency);
        if (target !== undefined) {
          dependencies.add(target);
        }
      }
    }
    return {
      directory,
      dependencies: directories.filter((dependency) =>
        dependencies.has(dependency),
      ),
    };
  });
  const pending = new Map(graph.map((pkg) => [pkg.directory, pkg]));
  while (pending.size > 0) {
    const ready = [...pending.values()].filter(({ dependencies }) =>
      dependencies.every((dependency) => !pending.has(dependency)),
    );
    if (ready.length === 0) {
      panic(
        `Dependency cycle in npm publishing inventory: ${[...pending.keys()].join(", ")}`,
      );
    }
    for (const { directory } of ready) {
      pending.delete(directory);
    }
  }
  return graph;
};

const selected = (directory: string): string =>
  `contains(fromJSON(needs.pack.outputs.packages), '${directory}')`;

const TRIGGERING_RUN_ORIGIN = [
  "&& (github.event_name != 'workflow_run'",
  "|| (github.event.workflow_run.head_repository.full_name == github.repository",
  "&& github.event.workflow_run.path == '.github/workflows/release.yml'",
  '&& contains(fromJSON(\'["push", "workflow_dispatch"]\'), github.event.workflow_run.event)))',
] as const;

export const renderNpmReleaseJobs = (
  graph: readonly NpmReleasePackage[],
): string => {
  const jobs = graph.map(({ directory, dependencies }) => {
    const lines = [
      `  ${npmReleaseJobId(directory)}:`,
      `    name: Publish @stll/${directory}`,
      "    needs:",
      "      - release-trigger",
      "      - pack",
      ...dependencies.map(
        (dependency) => `      - ${npmReleaseJobId(dependency)}`,
      ),
      "    if: >-",
      "      always() && !cancelled()",
      "      && needs.pack.result == 'success'",
      ...TRIGGERING_RUN_ORIGIN.map((line) => `      ${line}`),
      "      && (github.event_name == 'workflow_run'",
      "      || (github.ref == 'refs/heads/main'",
      "      && (github.event_name == 'push' || inputs.publish)))",
      `      && ${selected(directory)}`,
      ...dependencies.map(
        (dependency) =>
          `      && (!${selected(dependency)} || needs.${npmReleaseJobId(dependency)}.result == 'success')`,
      ),
      "    permissions:",
      "      actions: read",
      "      contents: write",
      "      id-token: write",
      `    uses: ${NPM_RELEASE_WORKFLOW} # release job environment input`,
      "    with:",
      "      environment: release-app",
      `      artifact-pattern: npm-tarball-${directory}`,
      `      artifact-run-id: \${{ inputs.artifact_run_id || '' }}`,
      `      package-files: packages/${directory}/package.json`,
      `      source-ref: \${{ needs.pack.outputs.source_sha }}`,
      "    secrets:",
      `      RELEASE_APP_ID: \${{ secrets.STELLA_RELEASE_APP_ID }}`,
      `      RELEASE_APP_PRIVATE_KEY: \${{ secrets.STELLA_RELEASE_APP_PRIVATE_KEY }}`,
    ];
    return lines.join("\n");
  });
  return [
    START,
    "  # Generated by scripts/generate-npm-release-jobs.ts; do not edit.",
    ...jobs,
    END,
  ].join("\n\n");
};

type RenderNpmReleaseWorkflowOptions = {
  source: string;
  graph: readonly NpmReleasePackage[];
};

export const renderNpmReleaseWorkflow = ({
  source,
  graph,
}: RenderNpmReleaseWorkflowOptions): string => {
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (
    start === -1 ||
    end < start ||
    source.includes(START, start + START.length) ||
    source.includes(END, end + END.length)
  ) {
    return panic(
      "publish-npm.yml must contain exactly one npm release jobs region",
    );
  }
  const rendered =
    source.slice(0, start) +
    renderNpmReleaseJobs(graph) +
    source.slice(end + END.length);
  const needs = [
    "release-trigger",
    "pack",
    ...graph.map(({ directory }) => npmReleaseJobId(directory)),
  ];
  const summary = `${SUMMARY_NEEDS}\n    needs:\n${needs.map((job) => `      - ${job}`).join("\n")}`;
  const summaryStart = rendered.indexOf(SUMMARY_NEEDS);
  if (
    summaryStart === -1 ||
    rendered.includes(SUMMARY_NEEDS, summaryStart + SUMMARY_NEEDS.length)
  ) {
    return panic(
      "publish-npm.yml must contain exactly one npm release summary needs marker",
    );
  }
  const summaryStanza =
    /^ {4}# npm-release-summary-needs\n {4}needs:[^\n]*(?:\n      - [^\n]+)*/mu;
  if (!summaryStanza.test(rendered)) {
    return panic(
      "npm release summary needs marker must precede its needs stanza",
    );
  }
  return rendered.replace(summaryStanza, () => summary);
};

type RenderNpmReleaseEventPolicyOptions = {
  source: string;
  graph: readonly NpmReleasePackage[];
};

export const renderNpmReleaseEventPolicy = ({
  source,
  graph,
}: RenderNpmReleaseEventPolicyOptions): string => {
  const policy: unknown = JSON.parse(source);
  if (!record(policy) || !record(policy["jobs"])) {
    return panic("CI event policy must contain a jobs map");
  }
  // The generated jobs retain the former single release job's main policy.
  const generated = new Map(
    graph.map(({ directory }) => [
      `publish-npm.yml/${npmReleaseJobId(directory)}`,
      RELEASE_EVENT_POLICY,
    ]),
  );
  generated.set("publish-npm.yml/release-summary", RELEASE_EVENT_POLICY);
  const entries: [string, unknown][] = [];
  let inserted = false;
  for (const [key, value] of Object.entries(policy["jobs"])) {
    const owned =
      key === "publish-npm.yml/release" ||
      (key.startsWith("publish-npm.yml/release-") &&
        key !== "publish-npm.yml/release-trigger");
    if (!owned) {
      entries.push([key, value]);
      continue;
    }
    if (!inserted) {
      for (const entry of generated) {
        entries.push(entry);
      }
      inserted = true;
    }
  }
  if (!inserted) {
    for (const entry of generated) {
      entries.push(entry);
    }
  }
  return `${JSON.stringify({ ...policy, jobs: Object.fromEntries(entries) }, null, 2)}\n`;
};

type NpmReleaseGraphProblemsOptions = {
  workflow: unknown;
  graph: readonly NpmReleasePackage[];
};

/** Catch jobs outside the generated region as well as missing dependency edges. */
export const npmReleaseGraphProblems = ({
  workflow,
  graph,
}: NpmReleaseGraphProblemsOptions): readonly string[] => {
  if (!record(workflow) || !record(workflow["jobs"])) {
    return ["publish-npm.yml has no jobs map"];
  }
  const jobs = workflow["jobs"];
  const expected = new Set(
    graph.map(({ directory }) => npmReleaseJobId(directory)),
  );
  const problems: string[] = [];
  for (const [id, job] of Object.entries(jobs)) {
    const releaseJob =
      (id.startsWith("release-") &&
        id !== "release-trigger" &&
        id !== "release-summary") ||
      (record(job) && job["uses"] === NPM_RELEASE_WORKFLOW);
    if (releaseJob && !expected.has(id)) {
      problems.push(`Unexpected npm release job: ${id}`);
    }
  }
  for (const { directory, dependencies } of graph) {
    const id = npmReleaseJobId(directory);
    const job = jobs[id];
    if (!record(job)) {
      problems.push(`Missing npm release job: ${id}`);
      continue;
    }
    const needs = job["needs"];
    const required = [
      "release-trigger",
      "pack",
      ...dependencies.map(npmReleaseJobId),
    ];
    if (
      !Array.isArray(needs) ||
      needs.length !== required.length ||
      !required.every((dependency) => needs.includes(dependency))
    ) {
      problems.push(
        `Incorrect npm release dependencies: ${id} needs ${required.join(", ")}`,
      );
    }
    if (job["uses"] !== NPM_RELEASE_WORKFLOW || "steps" in job) {
      problems.push(
        `npm release job must call the pinned reusable workflow: ${id}`,
      );
    }
  }
  return problems;
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "..");
  const file = path.join(root, WORKFLOW_PATH);
  const source = readFileSync(file, "utf-8");
  const graph = readNpmReleaseGraph({
    readManifest: (directory) =>
      readFileSync(
        path.join(root, "packages", directory, "package.json"),
        "utf-8",
      ),
  });
  const rendered = renderNpmReleaseWorkflow({ source, graph });
  const policyFile = path.join(root, EVENT_POLICY_PATH);
  const policySource = readFileSync(policyFile, "utf-8");
  const renderedPolicy = renderNpmReleaseEventPolicy({
    source: policySource,
    graph,
  });
  const problems = npmReleaseGraphProblems({
    workflow: Bun.YAML.parse(rendered),
    graph,
  });
  if (problems.length > 0) {
    panic(problems.join("\n"));
  }
  if (Bun.argv.includes("--write")) {
    writeFileSync(file, rendered);
    writeFileSync(policyFile, renderedPolicy);
  } else if (
    source !== rendered ||
    JSON.stringify(JSON.parse(policySource)) !==
      JSON.stringify(JSON.parse(renderedPolicy))
  ) {
    console.error(
      "npm release jobs or event policies drifted; run bun scripts/generate-npm-release-jobs.ts --write",
    );
    process.exitCode = 1;
  }
}
