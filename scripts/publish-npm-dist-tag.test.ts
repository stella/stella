import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const source = readFileSync(
  new URL("../.github/workflows/publish-npm.yml", import.meta.url),
  "utf-8",
);
const stepSchema = v.object({
  id: v.optional(v.string()),
  run: v.optional(v.string()),
});
const readWorkflow = (text: string) =>
  v.parse(
    v.object({
      jobs: v.object({
        "release-trigger": v.object({ steps: v.array(stepSchema) }),
        pack: v.object({ if: v.string(), steps: v.array(stepSchema) }),
        "release-cli": v.object({
          if: v.string(),
          uses: v.string(),
          with: v.record(v.string(), v.unknown()),
          permissions: v.record(v.string(), v.string()),
        }),
      }),
    }),
    Bun.YAML.parse(text),
  );
const workflow = readWorkflow(source);
const requiredRun = (steps: v.InferOutput<typeof stepSchema>[], id: string) =>
  v.parse(
    v.object({ run: v.string() }),
    steps.find((step) => step.id === id),
  ).run;

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
    const resolution = requiredRun(
      workflow.jobs["release-trigger"].steps,
      "source",
    );
    const result = Bun.spawnSync(["bash", "-c", resolution], {
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
    expect(workflow.jobs["release-cli"].if).toContain(
      "needs.pack.result == 'success'",
    );
    expect(workflow.jobs["release-cli"].with["dist-tag"]).toBeUndefined();
    expect(source).not.toContain("'next'");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("stable npm source must equal the final tag and its RC SHA through the unchanged publisher", () => {
  expect(workflow.jobs["release-cli"].uses).toBe(
    "stella/.github/.github/workflows/npm-independent-release.yml@5764ab66e4df84cfd2e642c7d7e4678261e668f8",
  );
  const validation = requiredRun(workflow.jobs.pack.steps, "release-source");
  expect(validation).toContain('if [[ "$source_sha" != "$release_sha" ]]');
  expect(validation).toContain('git tag --points-at "$release_sha"');
  expect(validation).toContain(
    `[[ "$(git rev-parse "refs/tags/\${rc_tag}^{commit}")" == "$source_sha" ]]`,
  );
  expect(validation).not.toContain("merge-base --is-ancestor");
  expect(workflow.jobs["release-cli"].permissions).toEqual({
    actions: "read",
    contents: "write",
    "id-token": "write",
  });
});
