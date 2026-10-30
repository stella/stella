import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { finalize } from "./release-finalize.fixture";

test("finalizes only the exact RC SHA when every evidence item is green", () => {
  const proof = finalize();
  expect(proof.result.exitCode, proof.result.stderr.toString()).toBe(0);
  expect(proof.finalSha).toBe(proof.sha);
  expect(proof.pushes).toContain("refs/tags/v1.2.3");
  expect(proof.publications).toContain("release edit v1.2.3-rc.2");
});

for (const context of ["staging/verified", "main/heavy", "main/pr-depth"]) {
  for (const state of ["failure", "pending", "missing"]) {
    test(`${context} ${state} creates no final tag or publication`, () => {
      const proof = finalize({ states: { [context]: state } });
      expect(proof.result.exitCode).not.toBe(0);
      expect(proof.finalSha).toBeNull();
      expect(proof.pushes).toBe("");
      expect(proof.publications).toBe("");
    });
  }
}

test("green receipts for another SHA create no final tag", () => {
  const proof = finalize({ runSha: "f".repeat(40) });
  expect(proof.result.exitCode).not.toBe(0);
  expect(proof.finalSha).toBeNull();
});
test("an unresolved incident creates no final tag", () => {
  const proof = finalize({ incidents: true });
  expect(proof.result.exitCode).not.toBe(0);
  expect(proof.finalSha).toBeNull();
});
test("a missing RC emits no final tag output and skips landing", () => {
  const proof = finalize({ noRc: true });
  expect(proof.stepOutput).toBe("");
  expect(proof.landing).toBeNull();
  expect(proof.merges).toBe("");
  expect(proof.result.exitCode, proof.result.stderr.toString()).toBe(0);
  expect(proof.pushes).toBe("");
  expect(proof.publications).toBe("");
});

test("an existing final tag on another commit refuses without writes", () => {
  const proof = finalize({ finalTag: "previous", rcPublication: "draft" });
  expect(proof.result.exitCode).not.toBe(0);
  expect(proof.result.stderr.toString()).toContain(
    "Final tag v1.2.3 already exists",
  );
  expect(proof.pushes).toBe("");
  expect(proof.publications).toBe("");
});

test("a failed publication after the tag push leaves the RC a draft", () => {
  const proof = finalize({ rcPublication: "draft", publicationFails: true });
  expect(proof.result.exitCode).not.toBe(0);
  expect(proof.pushes).toContain("refs/tags/v1.2.3");
  expect(proof.publications).toBe("");
});

// The retry of that failure: the tag is already on the candidate.
test("a retry with the final tag on the candidate publishes without pushing again", () => {
  const proof = finalize({ finalTag: "candidate", rcPublication: "draft" });
  expect(proof.result.exitCode, proof.result.stderr.toString()).toBe(0);
  expect(proof.result.stderr.toString()).toContain("resuming publication");
  expect(proof.pushes).toBe("");
  expect(proof.publications).toContain("release edit v1.2.3-rc.2");
});

for (const finalTag of [undefined, "candidate"] as const) {
  test(`finalization arms exactly the matching release head (${finalTag ?? "fresh"})`, () => {
    const proof = finalize({ finalTag });
    expect(proof.landing?.exitCode, proof.landing?.stderr.toString()).toBe(0);
    expect(proof.stepOutput).toBe("final_tag=v1.2.3\n");
    expect(proof.merges.trim()).toBe(
      `pr merge 123 --repo stella/stella --auto --match-head-commit ${proof.sha}`,
    );
  });
}

for (const pull of [
  "none",
  "multiple",
  "mismatch",
  "fork",
  "closed",
] as const) {
  test(`landing refuses ${pull} release PRs without merging`, () => {
    const proof = finalize({ pull });
    expect(proof.landing?.exitCode).toBe(1);
    expect(proof.landing?.stderr.toString()).toContain("::error::");
    expect(proof.landing?.stderr.toString()).toContain("release/v1.2.3");
    expect(proof.landing?.stderr.toString()).toContain(
      pull === "none" || pull === "fork"
        ? "found: none"
        : "#123 chore: release v1.2.3",
    );
    expect(proof.merges).toBe("");
  });
}

test("a fork PR with the release head branch name is ignored beside the real one", () => {
  const proof = finalize({ pull: "fork-alongside" });
  expect(proof.landing?.exitCode, proof.landing?.stderr.toString()).toBe(0);
  expect(proof.merges.trim()).toBe(
    `pr merge 123 --repo stella/stella --auto --match-head-commit ${proof.sha}`,
  );
});

for (const pull of ["merged", "armed", "queued"] as const) {
  test(`a rerun after the release PR is ${pull} performs no merge`, () => {
    const proof = finalize({
      pull,
      finalTag: "candidate",
      rcPublication: "published",
    });
    expect(proof.landing?.exitCode, proof.landing?.stderr.toString()).toBe(0);
    expect(proof.merges).toBe("");
    expect(proof.pushes).toBe("");
    expect(proof.publications).toBe("");
    if (pull === "queued") {
      expect(proof.landing?.stdout.toString()).toContain(
        "::notice::Release PR #123",
      );
    }
  });
}

test("a merge command failure propagates", () => {
  const proof = finalize({ mergeFails: true });
  expect(proof.landing?.exitCode).toBe(1);
  expect(proof.landing?.stderr.toString()).toContain("merge failed");
});

test("release landing waits for finalization and uses trusted tooling with a separate scoped token", () => {
  const step = v.looseObject({
    uses: v.optional(v.string()),
    run: v.optional(v.string()),
    with: v.optional(v.record(v.string(), v.unknown())),
  });
  const workflow = v.parse(
    v.looseObject({
      jobs: v.looseObject({
        finalize: v.looseObject({
          steps: v.array(step),
          outputs: v.record(v.string(), v.string()),
        }),
        "land-release-pr": v.looseObject({
          needs: v.string(),
          if: v.string(),
          permissions: v.record(v.string(), v.unknown()),
          steps: v.array(step),
        }),
      }),
    }),
    Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/release-tag.yml", import.meta.url),
        "utf-8",
      ),
    ),
  );
  const landing = workflow.jobs["land-release-pr"];
  expect(landing.needs).toBe("finalize");
  expect(landing.if).toBe(
    "github.event_name == 'workflow_run' && needs.finalize.outputs.final_tag != ''",
  );
  expect(workflow.jobs.finalize.outputs["final_tag"]).toBe(
    `\${{ steps.finalize.outputs.final_tag }}`,
  );
  expect(landing.permissions).toEqual({});
  expect(workflow.jobs.finalize.outputs["sha"]).toBe(
    `\${{ needs.finalize-eligibility.outputs.sha }}`,
  );
  const tagToken = workflow.jobs.finalize.steps.find(({ uses }) =>
    uses?.startsWith("actions/create-github-app-token@"),
  )?.with;
  expect(tagToken?.["permission-contents"]).toBe("write");
  expect(tagToken?.["permission-pull-requests"]).toBeUndefined();
  const token = landing.steps.find(({ uses }) =>
    uses?.startsWith("actions/create-github-app-token@"),
  )?.with;
  expect(token).toMatchObject({
    "client-id": `\${{ secrets.CHANGELOG_APP_ID }}`,
    "private-key": `\${{ secrets.CHANGELOG_APP_PRIVATE_KEY }}`,
    owner: `\${{ github.repository_owner }}`,
    repositories: `\${{ github.event.repository.name }}`,
    "permission-contents": "write",
    "permission-pull-requests": "write",
  });
  const checkout = landing.steps.find(({ uses }) =>
    uses?.startsWith("actions/checkout@"),
  )?.with;
  expect(checkout?.["ref"]).toBe("main");
  expect(checkout?.["persist-credentials"]).toBe(false);
  expect(checkout?.["sparse-checkout"]).toContain("scripts/land-release-pr.sh");
  expect(
    landing.steps.filter(({ run }) => run !== undefined).map(({ run }) => run),
  ).toEqual([
    'bash scripts/land-release-pr.sh "$GITHUB_REPOSITORY" "$RELEASE_SHA"',
  ]);
});
