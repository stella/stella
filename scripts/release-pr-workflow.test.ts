import { expect, test } from "bun:test";

test("release reconciliation only hands main batches to the pinned merge gate", async () => {
  const workflow = await Bun.file(
    new URL("../.github/workflows/release-pr.yml", import.meta.url),
  ).text();
  expect(workflow).toContain("schedule:");
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
  expect(workflow).toContain("cancel-in-progress: false");
  expect(workflow).toMatch(/changeset-release-pr\.yml@[0-9a-f]{40}/u);
  expect(workflow).toContain(
    'auto-merge-command: bun scripts/merge-bar.ts "$RELEASE_PR_NUMBER"',
  );
  expect(workflow).toContain("pull-requests: read");
  expect(workflow).not.toContain("--admin");
  expect(workflow).not.toContain("pull_request_target:");
});
