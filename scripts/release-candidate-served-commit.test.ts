import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const releasePath = path.join(
  import.meta.dirname,
  "../.github/workflows/release.yml",
);
const stagingPath = path.join(
  import.meta.dirname,
  "../.github/workflows/deploy-staging.yml",
);
const finalizePath = path.join(import.meta.dirname, "finalize-release.sh");

describe("release-candidate commit identity", () => {
  test("every proof dispatch receives the peeled release tag commit", async () => {
    const release = await readFile(releasePath, "utf-8");
    const dispatch = release.slice(
      release.indexOf("name: Dispatch staging and heavy on the candidate SHA"),
      release.indexOf("\n  release-complete:"),
    );
    expect(dispatch).toContain(
      `SHA: \${{ needs.resolve.outputs.release_sha }}`,
    );
    for (const workflow of [
      "deploy-staging.yml",
      "main-heavy.yml",
      "main-pr-depth.yml",
    ]) {
      const line = dispatch
        .split("\n")
        .find((candidate) =>
          candidate.includes(`/workflows/${workflow}/dispatches`),
        );
      expect(line, workflow).toContain("inputs[sha]=$SHA");
      expect(line, workflow).not.toContain("github.head_ref");
    }
    expect(release).toContain(
      `release_sha=$(bash "$GH_RETRY_SCRIPT" api "repos/\${GITHUB_REPOSITORY}/git/tags/\${tag_object_sha}"`,
    );
  });

  test("finalization asserts the final and candidate tags target the shipped commit", async () => {
    const finalize = await readFile(finalizePath, "utf-8");
    expect(finalize).toContain(
      '[[ "$(git rev-parse "$final^{commit}")" == "$sha" ]]',
    );
    expect(finalize).toContain('[[ "$rc_sha" == "$sha" ]]');
    expect(finalize).toContain('git tag -a "$final" "$rc_sha"');
  });

  test("a served-commit change after smokes prevents staging verification", async () => {
    const staging = await readFile(stagingPath, "utf-8");
    const finalCheck = staging.indexOf(
      "name: Verify candidate staging commit after smokes",
    );
    const record = staging.indexOf("name: Record staging verification");
    expect(finalCheck).toBeGreaterThan(
      staging.indexOf("name: Run mock-model application journeys"),
    );
    expect(finalCheck).toBeLessThan(record);
    const finalBlock = staging.slice(finalCheck, record);
    expect(finalBlock).toContain(
      `API_DEPLOYMENT_EXPECTED_COMMIT: \${{ needs.resolve.outputs.sha }}`,
    );
    expect(finalBlock).not.toContain("github.head_ref");
    expect(staging.slice(record, record + 300)).toContain(
      "steps.candidate-served-after-smokes.outcome == 'success'",
    );
  });
});
