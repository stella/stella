import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

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
  Bun.YAML.parse(
    await Bun.file(
      new URL("../.github/workflows/model-catalog-check.yml", import.meta.url),
    ).text(),
  ),
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
