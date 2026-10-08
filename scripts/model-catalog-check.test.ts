import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const workflowDocument = Bun.YAML.parse(
  await Bun.file(
    new URL("../.github/workflows/model-catalog-check.yml", import.meta.url),
  ).text(),
);

const workflow = v.parse(
  v.object({
    jobs: v.object({
      "model-catalog-check": v.object({
        steps: v.array(
          v.object({ id: v.optional(v.string()), run: v.optional(v.string()) }),
        ),
      }),
    }),
  }),
  workflowDocument,
);
const restore = workflow.jobs["model-catalog-check"].steps.find(
  ({ id }) => id === "benchmark-state",
)?.run;
if (!restore) {
  panic("Missing benchmark state restore step");
}

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

type RestoreFixture = {
  artifacts: unknown;
  listExit?: number;
  downloadExit?: number;
};
const restoreState = async ({
  artifacts,
  listExit = 0,
  downloadExit = 0,
}: RestoreFixture) => {
  const directory = await mkdtemp(path.join(tmpdir(), "benchmark-restore-"));
  directories.push(directory);
  const artifactFile = path.join(directory, "artifacts.json");
  const zipFile = path.join(directory, "state.zip");
  await Bun.write(artifactFile, JSON.stringify(artifacts));
  await Bun.write(
    path.join(directory, "state.json"),
    '{"consecutiveInconclusive":2}',
  );
  const zip = Bun.spawn(["zip", "-q", zipFile, "state.json"], {
    cwd: directory,
  });
  expect(await zip.exited).toBe(0);
  const ghFile = path.join(directory, "gh");
  await Bun.write(
    ghFile,
    `#!/bin/sh
case "$2" in
  */zip) [ "$DOWNLOAD_EXIT" = 0 ] || exit "$DOWNLOAD_EXIT"; cat "$FAKE_ZIP_FILE" ;;
  *) [ "$LIST_EXIT" = 0 ] || exit "$LIST_EXIT"; cat "$FAKE_ARTIFACT_FILE" ;;
esac
`,
  );
  await chmod(ghFile, 0o755);
  const child = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", restore], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: [directory, process.env["PATH"]]
        .filter((entry) => entry !== undefined)
        .join(path.delimiter),
      GH_REPO: "fixture/repository",
      GH_RETRY_SCRIPT: path.resolve(import.meta.dir, "gh-retry.sh"),
      FAKE_ZIP_FILE: zipFile,
      FAKE_ARTIFACT_FILE: artifactFile,
      LIST_EXIT: String(listExit),
      DOWNLOAD_EXIT: String(downloadExit),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    exitCode,
    output: output + error,
    stateFile: Bun.file(path.join(directory, ".benchmark-state/state.json")),
  };
};

describe("scheduled benchmark state restore", () => {
  test("starts a new streak only when no saved artifact exists", async () => {
    const result = await restoreState({ artifacts: { artifacts: [] } });
    expect(result.exitCode).toBe(0);
    expect(await result.stateFile.exists()).toBe(false);
  });

  test("restores the saved streak for the next scheduled check", async () => {
    const result = await restoreState({
      artifacts: { artifacts: [{ id: 42, expired: false }] },
    });
    expect(result.exitCode).toBe(0);
    expect(await result.stateFile.json()).toEqual({
      consecutiveInconclusive: 2,
    });
  });

  test.each([
    { artifacts: {}, listExit: 1 },
    { artifacts: {} },
    { artifacts: { artifacts: [{ expired: false }] } },
    { artifacts: { artifacts: [{ id: 42, expired: true }] } },
    { artifacts: { artifacts: [{ id: 42, expired: false }] }, downloadExit: 1 },
  ])(
    "alerts on unavailable, malformed, or expired state: %j",
    async (fixture) => {
      const result = await restoreState(fixture);
      expect(result.exitCode).not.toBe(0);
    },
  );
});

const catalogSteps = workflowJobSteps(workflowDocument, "model-catalog-check");
const refreshStep = workflowStepByName(
  catalogSteps,
  "Refresh upstream catalog snapshots",
);
const refreshCommand = v.parse(v.string(), refreshStep["run"]);

const runRefresh = async (
  mode: "unchanged" | "changed" | "unexpected" | "failed",
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "catalog-refresh-"));
  directories.push(directory);
  for (const child of [
    ".changeset",
    ".benchmark-state",
    "packages/ai-catalog/upstream",
    "packages/ai-catalog/src",
  ]) {
    await mkdir(path.join(directory, child), { recursive: true });
  }
  await Bun.write(
    path.join(directory, "packages/ai-catalog/upstream/models.dev.gen.json"),
    "{}\n",
  );
  await Bun.write(
    path.join(directory, "packages/ai-catalog/upstream/openrouter.gen.json"),
    "[]\n",
  );
  await Bun.write(
    path.join(directory, "packages/ai-catalog/src/model-rates.gen.ts"),
    "// rates\n",
  );
  await Bun.write(
    path.join(directory, "packages/ai-catalog/src/capabilities.gen.ts"),
    "// capabilities\n",
  );
  for (const command of [
    ["git", "init", "-q"],
    ["git", "add", "packages"],
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ],
  ]) {
    const child = Bun.spawn(command, {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
  }
  // Restored benchmark state must not enter the catalog proposal.
  await Bun.write(path.join(directory, ".benchmark-state/state.json"), "{}\n");
  // Tooling lives outside the checkout's write-confinement boundary.
  const tooling = await mkdtemp(path.join(tmpdir(), "catalog-refresh-tools-"));
  directories.push(tooling);
  const bunFile = path.join(tooling, "bun");
  await Bun.write(
    bunFile,
    `#!/bin/bash
printf '%s\\n' "$*" >> "$RUNNER_TEMP/calls"
if [[ "$*" == *gen:rates* ]]; then
  case "$FIXTURE_MODE" in
    failed) exit 1 ;;
    changed) echo '{"updated":true}' > packages/ai-catalog/upstream/models.dev.gen.json ;;
    unexpected) echo unexpected > packages/ai-catalog/src/unexpected.ts ;;
  esac
fi
`,
  );
  await chmod(bunFile, 0o755);
  const outputFile = path.join(tooling, "output");
  const child = Bun.spawn(
    ["bash", "-e", "-o", "pipefail", "-c", refreshCommand],
    {
      cwd: directory,
      env: {
        ...process.env,
        PATH: [tooling, process.env["PATH"]]
          .filter((entry) => entry !== undefined)
          .join(path.delimiter),
        FIXTURE_MODE: mode,
        RUNNER_TEMP: tooling,
        GITHUB_OUTPUT: outputFile,
        REFRESH_CHANGESET: ".changeset/model-catalog-refresh.md",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    exitCode,
    log: stdout + stderr,
    output: (await Bun.file(outputFile).exists())
      ? await Bun.file(outputFile).text()
      : "",
    calls: await Bun.file(path.join(tooling, "calls")).text(),
    changeset: Bun.file(
      path.join(directory, ".changeset/model-catalog-refresh.md"),
    ),
  };
};

describe("scheduled catalog refresh", () => {
  test("unchanged inputs produce no proposal", async () => {
    const result = await runRefresh("unchanged");
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("changed=false\n");
    expect(await result.changeset.exists()).toBe(false);
  });

  test("upstream input drift produces one batched patch proposal", async () => {
    const result = await runRefresh("changed");
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("changed=true\n");
    expect(result.calls.trim().split("\n")).toEqual([
      "--filter @stll/ai-catalog gen:rates --refresh",
      "--filter @stll/ai-catalog gen:capabilities --from-snapshot",
    ]);
    expect(await result.changeset.text()).toContain(
      '"@stll/ai-catalog": patch',
    );
  });

  test("unrelated generator writes cannot enter a proposal", async () => {
    const result = await runRefresh("unexpected");
    expect(result.exitCode).not.toBe(0);
    expect(result.log).toContain(
      "The refresh changed files outside the catalog snapshots.",
    );
    expect(result.output).not.toContain("changed=true");
  });

  test("upstream refresh failures alert without proposing partial output", async () => {
    const result = await runRefresh("failed");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).not.toContain("changed=true");
    expect(await result.changeset.exists()).toBe(false);
  });

  test("one app-authenticated signed branch is maintained even when discovery alerts", () => {
    const token = workflowStepByName(catalogSteps, "Mint app token");
    const proposal = workflowStepByName(
      catalogSteps,
      "Open or update the refresh PR",
    );
    const discovery = workflowStepByName(
      catalogSteps,
      "Discover models and validate IDs, rates, and capabilities",
    );
    expect(token["uses"]).toMatch(
      /^actions\/create-github-app-token@[a-f0-9]{40}$/u,
    );
    expect(token["if"]).toContain("!cancelled()");
    expect(token["if"]).toContain("github.repository == 'stella/stella'");
    expect(token["if"]).toContain("github.ref == 'refs/heads/main'");
    expect(token["if"]).toContain("steps.refresh.outcome == 'success'");
    expect(proposal["if"]).toContain("!cancelled()");
    expect(proposal["if"]).toContain("steps.app-token.outcome == 'success'");
    expect(proposal["uses"]).toMatch(
      /^stella\/\.github\/\.github\/actions\/signed-commit@[a-f0-9]{40}$/u,
    );
    const inputs = v.parse(v.record(v.string(), v.string()), proposal["with"]);
    expect(inputs["token"]).toBe(`\${{ steps.app-token.outputs.token }}`);
    expect(inputs["mode"]).toBe("refresh-pr");
    expect(inputs["branch"]).toBe(`\${{ env.REFRESH_BRANCH }}`);
    expect(inputs["paths"]?.trim().split("\n")).toEqual([
      "packages/ai-catalog/upstream/models.dev.gen.json",
      "packages/ai-catalog/upstream/openrouter.gen.json",
      "packages/ai-catalog/src/model-rates.gen.ts",
      "packages/ai-catalog/src/capabilities.gen.ts",
      ".changeset/model-catalog-refresh.md",
    ]);
    expect(discovery["continue-on-error"]).toBeUndefined();
    expect(discovery["run"]).toContain(
      "bun packages/scripts/src/model-catalog-upstream.ts",
    );
    expect(catalogSteps.indexOf(refreshStep)).toBeLessThan(
      catalogSteps.indexOf(discovery),
    );
  });
});
