import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const source = readFileSync(
  new URL("../.github/workflows/publish-npm.yml", import.meta.url),
  "utf-8",
);
const workflow = Bun.YAML.parse(source);

test("RC runs publish no npm version or dist-tag", () => {
  const work = mkdtempSync(path.join(tmpdir(), "stella-npm-trigger-"));
  try {
    const receiptDirectory = path.join(work, "release-source-receipt");
    const prepare = Bun.spawnSync(["mkdir", "-p", receiptDirectory]);
    expect(prepare.exitCode).toBe(0);
    writeFileSync(
      path.join(receiptDirectory, "release-source-receipt.json"),
      JSON.stringify({
        release_ref: "v1.2.3-rc.7",
        release_sha: "a".repeat(40),
      }),
    );
    const retry = path.join(work, "gh-retry.sh");
    writeFileSync(retry, '[[ "$1" == run && "$2" == download ]] || exit 99\n');
    const output = path.join(work, "output");
    const resolution = workflow.jobs["release-trigger"].steps.find(
      (step: { id?: string }) => step.id === "source",
    );
    const result = Bun.spawnSync(["bash", "-c", resolution.run], {
      env: {
        ...process.env,
        EVENT_NAME: "workflow_run",
        RUNNER_TEMP: work,
        GH_RETRY_SCRIPT: retry,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "stella/stella",
        UPSTREAM_RUN_ID: "123",
      },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(output, "utf-8")).toContain("eligible=false\n");
    expect(workflow.jobs.pack.if).toContain(
      "needs.release-trigger.outputs.eligible == 'true'",
    );
    expect(workflow.jobs.release.if).toContain(
      "needs.pack.result == 'success'",
    );
    expect(workflow.jobs.release.with["dist-tag"]).toBeUndefined();
    expect(source).not.toContain("'next'");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("stable npm source must equal the final tag and its RC SHA through the unchanged publisher", () => {
  expect(workflow.jobs.release.uses).toBe(
    "stella/.github/.github/workflows/npm-independent-release.yml@5764ab66e4df84cfd2e642c7d7e4678261e668f8",
  );
  const validation = workflow.jobs.pack.steps.find(
    (step: { id?: string }) => step.id === "release-source",
  );
  expect(validation.run).toContain('if [[ "$source_sha" != "$release_sha" ]]');
  expect(validation.run).toContain('git tag --points-at "$release_sha"');
  expect(validation.run).toContain(
    `[[ "$(git rev-parse "refs/tags/\${rc_tag}^{commit}")" == "$source_sha" ]]`,
  );
  expect(validation.run).not.toContain("merge-base --is-ancestor");
  expect(workflow.jobs.release.permissions).toEqual({
    actions: "read",
    contents: "write",
    "id-token": "write",
  });
});
