import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  NPM_RELEASE_WORKFLOW,
  npmReleaseGraphProblems,
  readNpmReleaseGraph,
  renderNpmReleaseEventPolicy,
  renderNpmReleaseJobs,
  renderNpmReleaseWorkflow,
} from "./generate-npm-release-jobs";
import { evaluate } from "./github-expression";
import { ALL_PACKAGE_ORDER, npmReleaseJobId } from "./publish-packages";

const ROOT = path.resolve(import.meta.dirname, "..");
const workflowSource = () =>
  readFileSync(path.join(ROOT, ".github/workflows/publish-npm.yml"), "utf-8");
const repositoryGraph = () =>
  readNpmReleaseGraph({
    readManifest: (directory) =>
      readFileSync(
        path.join(ROOT, "packages", directory, "package.json"),
        "utf-8",
      ),
  });
const generatedJobs = (graph: ReturnType<typeof readNpmReleaseGraph>) =>
  v.parse(
    v.object({
      jobs: v.record(
        v.string(),
        v.looseObject({
          needs: v.array(v.string()),
          if: v.string(),
          uses: v.string(),
        }),
      ),
    }),
    Bun.YAML.parse(`jobs:\n${renderNpmReleaseJobs(graph)}`),
  ).jobs;

const fixtureGraph = () => {
  const manifests: Record<string, unknown> = {
    base: { name: "@stll/base" },
    adapter: {
      name: "@stll/adapter",
      dependencies: { "@stll/base": "workspace:*", external: "1.0.0" },
    },
    cli: { name: "@stll/cli", dependencies: { "@stll/adapter": "1.0.0" } },
    independent: {
      name: "@stll/independent",
      devDependencies: { "@stll/base": "workspace:*" },
    },
  };
  return readNpmReleaseGraph({
    directories: Object.keys(manifests),
    readManifest: (directory) => JSON.stringify(manifests[directory]),
  });
};

const parseEventPolicy = (source: string) =>
  v.parse(
    v.looseObject({ jobs: v.record(v.string(), v.string()) }),
    JSON.parse(source),
  );

describe("generated npm release event policies", () => {
  test("committed policy covers every generated package and summary with the original main policy", () => {
    const source = readFileSync(
      path.join(ROOT, ".github/ci-event-policy.json"),
      "utf-8",
    );
    const graph = repositoryGraph();
    const policy = parseEventPolicy(source);
    expect(
      parseEventPolicy(renderNpmReleaseEventPolicy({ source, graph })),
    ).toEqual(policy);
    for (const id of [
      ...graph.map(({ directory }) => npmReleaseJobId(directory)),
      "release-summary",
    ]) {
      expect(policy.jobs[`publish-npm.yml/${id}`]).toBe("main");
    }
    expect(policy.jobs["publish-npm.yml/release"]).toBeUndefined();
  });

  test("replacement preserves other jobs and workflow-level policy", () => {
    const graph = fixtureGraph();
    const source = {
      jobs: {
        "publish-npm.yml/release": "main",
        "publish-npm.yml/release-trigger": "main",
        "publish-npm.yml/pack": "main",
        "publish-npm.yml/verify-npm": "main",
        "other.yml/check": "pr-fast",
      },
      pushMain: {
        "publish-npm.yml": { role: "publish", cancelInProgress: false },
      },
      periodicJobs: ["other.yml/periodic"],
    };
    const policy = parseEventPolicy(
      renderNpmReleaseEventPolicy({ source: JSON.stringify(source), graph }),
    );
    expect(policy.jobs).toEqual({
      ...Object.fromEntries(
        [
          ...graph.map(
            ({ directory }) => `publish-npm.yml/${npmReleaseJobId(directory)}`,
          ),
          "publish-npm.yml/release-summary",
        ].map((key) => [key, "main"]),
      ),
      "publish-npm.yml/release-trigger": "main",
      "publish-npm.yml/pack": "main",
      "publish-npm.yml/verify-npm": "main",
      "other.yml/check": "pr-fast",
    });
    expect(policy["pushMain"]).toEqual(source.pushMain);
    expect(policy["periodicJobs"]).toEqual(source.periodicJobs);
  });

  test("missing, extra, stale and changed package policies fail the fixed-point drift check", () => {
    const graph = fixtureGraph();
    const correct = parseEventPolicy(
      renderNpmReleaseEventPolicy({
        source: JSON.stringify({ jobs: {} }),
        graph,
      }),
    );
    const first = "publish-npm.yml/release-base";
    const mutations = {
      missing: Object.fromEntries(
        Object.entries(correct.jobs).filter(([key]) => key !== first),
      ),
      extra: { ...correct.jobs, "publish-npm.yml/release-extra": "main" },
      stale: { ...correct.jobs, "publish-npm.yml/release": "main" },
      changed: { ...correct.jobs, [first]: "pr-fast" },
    };
    for (const [mode, jobs] of Object.entries(mutations)) {
      const broken = { jobs };
      expect(broken, mode).not.toEqual(correct);
      expect(
        parseEventPolicy(
          renderNpmReleaseEventPolicy({
            source: JSON.stringify(broken),
            graph,
          }),
        ),
        mode,
      ).toEqual(correct);
    }
  });
});

describe("generated npm publishing dependency graph", () => {
  test("privileged jobs only delegate to the pinned workflow and summary has no release authority", () => {
    const workflow = v.parse(
      v.looseObject({
        jobs: v.record(
          v.string(),
          v.looseObject({
            permissions: v.optional(v.record(v.string(), v.string())),
            uses: v.optional(v.string()),
            steps: v.optional(v.unknown()),
            "runs-on": v.optional(v.unknown()),
            environment: v.optional(v.unknown()),
            secrets: v.optional(v.unknown()),
          }),
        ),
      }),
      Bun.YAML.parse(workflowSource()),
    );
    let publishers = 0;
    for (const job of Object.values(workflow.jobs)) {
      const hasReleaseSecret = JSON.stringify(job).includes(
        "secrets.STELLA_RELEASE_APP",
      );
      if (job.permissions?.["id-token"] !== "write" && !hasReleaseSecret) {
        continue;
      }
      publishers += 1;
      expect(job.uses).toBe(NPM_RELEASE_WORKFLOW);
      expect(job.steps).toBeUndefined();
      expect(job["runs-on"]).toBeUndefined();
    }
    expect(publishers).toBe(ALL_PACKAGE_ORDER.length);
    const summary = workflow.jobs["release-summary"];
    expect(summary?.permissions).toEqual({ contents: "read" });
    expect(summary?.environment).toBeUndefined();
    expect(summary?.secrets).toBeUndefined();
  });

  test("committed jobs are exactly the inventory and every same-release dependency edge", () => {
    const graph = repositoryGraph();
    expect(graph.map(({ directory }) => directory)).toEqual([
      ...ALL_PACKAGE_ORDER,
    ]);
    const source = workflowSource();
    expect(
      npmReleaseGraphProblems({ workflow: Bun.YAML.parse(source), graph }),
    ).toEqual([]);
    expect(renderNpmReleaseWorkflow({ source, graph })).toBe(source);
  });

  test("missing or malformed summary ownership markers cannot silently skip generation", () => {
    const source = workflowSource();
    const graph = repositoryGraph();
    const marker = "    # npm-release-summary-needs";
    expect(source).toContain(`${marker}\n    needs:`);
    expect(() =>
      renderNpmReleaseWorkflow({ source: source.replace(marker, ""), graph }),
    ).toThrow("exactly one npm release summary needs marker");
    expect(() =>
      renderNpmReleaseWorkflow({
        source: source.replace(marker, () => `${marker}\n${marker}`),
        graph,
      }),
    ).toThrow("exactly one npm release summary needs marker");
    expect(() =>
      renderNpmReleaseWorkflow({
        source: source.replace(
          `${marker}\n    needs:`,
          () => `${marker}\n    unexpected:`,
        ),
        graph,
      }),
    ).toThrow("must precede its needs stanza");
  });

  test("a missing job, extra job or missing dependency edge fails the drift guard", () => {
    const graph = fixtureGraph();
    const jobs = generatedJobs(graph);
    expect(npmReleaseGraphProblems({ workflow: { jobs }, graph })).toEqual([]);
    const { "release-base": removed, ...missing } = jobs;
    expect(removed).toBeDefined();
    expect(
      npmReleaseGraphProblems({ workflow: { jobs: missing }, graph }),
    ).toContain("Missing npm release job: release-base");
    expect(
      npmReleaseGraphProblems({
        workflow: { jobs: { ...jobs, "release-extra": removed } },
        graph,
      }),
    ).toContain("Unexpected npm release job: release-extra");
    const adapter = jobs["release-adapter"];
    expect(adapter?.needs).toContain("release-base");
    expect(
      npmReleaseGraphProblems({
        workflow: {
          jobs: {
            ...jobs,
            "release-adapter": {
              ...adapter,
              needs: ["release-trigger", "pack"],
            },
          },
        },
        graph,
      }),
    ).toContain(
      "Incorrect npm release dependencies: release-adapter needs release-trigger, pack, release-base",
    );
  });

  test("each privileged job delegates one exact artifact and contains no repository steps", () => {
    const graph = repositoryGraph();
    const jobs = v.parse(
      v.object({
        jobs: v.record(
          v.string(),
          v.looseObject({
            uses: v.string(),
            with: v.record(v.string(), v.unknown()),
            permissions: v.record(v.string(), v.string()),
            steps: v.optional(v.unknown()),
          }),
        ),
      }),
      Bun.YAML.parse(`jobs:\n${renderNpmReleaseJobs(graph)}`),
    ).jobs;
    for (const { directory } of graph) {
      const job = jobs[npmReleaseJobId(directory)];
      expect(job?.uses).toBe(NPM_RELEASE_WORKFLOW);
      expect(job?.steps).toBeUndefined();
      expect(job?.permissions).toEqual({
        actions: "read",
        contents: "write",
        "id-token": "write",
      });
      expect(job?.with["package-files"]).toBe(
        `packages/${directory}/package.json`,
      );
      expect(job?.with["artifact-pattern"]).toBe(`npm-tarball-${directory}`);
      expect(job?.with["environment"]).toBe("release-app");
      expect(job?.with["artifact-run-id"]).toBe(
        `\${{ inputs.artifact_run_id || '' }}`,
      );
    }
  });

  test("production, optional and peer dependencies become edges; development and external dependencies do not", () => {
    const graph = readNpmReleaseGraph({
      directories: ["base", "consumer"],
      readManifest: (directory) =>
        JSON.stringify(
          directory === "base"
            ? { name: "@stll/base" }
            : {
                name: "@stll/consumer",
                optionalDependencies: { "@stll/base": "workspace:*" },
                peerDependencies: { "@stll/base": "1.0.0", external: "1.0.0" },
                devDependencies: { "@stll/consumer": "workspace:*" },
              },
        ),
    });
    expect(graph).toEqual([
      { directory: "base", dependencies: [] },
      { directory: "consumer", dependencies: ["base"] },
    ]);
    expect(
      fixtureGraph().find(({ directory }) => directory === "independent")
        ?.dependencies,
    ).toEqual([]);
  });

  test("cycles, duplicate inventory entries and malformed public manifests fail before generation", () => {
    expect(() =>
      readNpmReleaseGraph({
        directories: ["one", "two"],
        readManifest: (directory) =>
          JSON.stringify({
            name: `@stll/${directory}`,
            dependencies: {
              [`@stll/${directory === "one" ? "two" : "one"}`]: "workspace:*",
            },
          }),
      }),
    ).toThrow("Dependency cycle in npm publishing inventory");
    expect(() =>
      readNpmReleaseGraph({
        directories: ["one", "one"],
        readManifest: () => "{}",
      }),
    ).toThrow("Duplicate package in npm publishing inventory");
    expect(() =>
      readNpmReleaseGraph({
        directories: ["one"],
        readManifest: () => JSON.stringify({ name: "@stll/another" }),
      }),
    ).toThrow("Invalid public manifest");
    expect(() =>
      readNpmReleaseGraph({
        directories: ["invalid'name"],
        readManifest: () => "{}",
      }),
    ).toThrow("Invalid directory in npm publishing inventory");
  });
});

type PublicationDecisionOptions = {
  condition: string;
  selected: readonly string[];
  results: Record<string, string>;
  cancelled?: boolean;
};
const publicationDecision = ({
  condition,
  selected,
  results,
  cancelled = false,
}: PublicationDecisionOptions) =>
  evaluate(condition, {
    status: { always: true, cancelled },
    values: {
      "needs.pack.result": "success",
      "needs.pack.outputs.packages": JSON.stringify(selected),
      "github.event_name": "workflow_dispatch",
      "github.ref": "refs/heads/main",
      "inputs.publish": true,
      ...Object.fromEntries(
        Object.entries(results).map(([directory, result]) => [
          `needs.${npmReleaseJobId(directory)}.result`,
          result,
        ]),
      ),
    },
  });

describe("package selection and dependency failures", () => {
  test("a failed package blocks descendants while independent siblings remain eligible", () => {
    const graph = fixtureGraph();
    const jobs = generatedJobs(graph);
    const selected = graph.map(({ directory }) => directory);
    for (const [directory, wanted] of [
      ["adapter", false],
      ["cli", false],
      ["independent", true],
    ] as const) {
      const condition = jobs[npmReleaseJobId(directory)]?.if;
      expect(condition).toBeDefined();
      expect(
        publicationDecision({
          condition: condition ?? "false",
          selected,
          results: { base: "failure", adapter: "skipped" },
        }),
      ).toBe(wanted);
    }
  });

  test("single-package dispatch runs its job even when every unselected dependency job is skipped", () => {
    const graph = fixtureGraph();
    const jobs = generatedJobs(graph);
    for (const { directory } of graph) {
      for (const { directory: candidate } of graph) {
        expect(
          publicationDecision({
            condition: jobs[npmReleaseJobId(candidate)]?.if ?? "false",
            selected: [directory],
            results: Object.fromEntries(
              graph.map((pkg) => [pkg.directory, "skipped"]),
            ),
          }),
        ).toBe(candidate === directory);
      }
    }
  });

  test("cancelled dependencies and cancelled workflows never publish consumers", () => {
    const jobs = generatedJobs(fixtureGraph());
    const condition = jobs["release-adapter"]?.if ?? "false";
    expect(
      publicationDecision({
        condition,
        selected: ["base", "adapter"],
        results: { base: "cancelled" },
      }),
    ).toBe(false);
    expect(
      publicationDecision({
        condition,
        selected: ["adapter"],
        results: { base: "skipped" },
        cancelled: true,
      }),
    ).toBe(false);
  });
});
