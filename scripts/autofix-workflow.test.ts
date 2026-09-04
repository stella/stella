import { describe, expect, test } from "bun:test";

const WORKFLOW_URL = new URL(
  "../.github/workflows/autofix.yml",
  import.meta.url,
);
const HELPER_URL = new URL("dependabot-empty-changeset.ts", import.meta.url);
const HELPER_TEST_URL = new URL(
  "dependabot-empty-changeset.test.ts",
  import.meta.url,
);
const CHANGESET_GUARD_URL = new URL("changeset-guard.ts", import.meta.url);

describe("Dependabot Bun autofix boundary", () => {
  test("keeps the runner read-only and hands off only verified autofixes", async () => {
    const workflow = await Bun.file(WORKFLOW_URL).text();
    const restrictionStep = workflow.indexOf(
      "- name: Restrict generated changes",
    );
    const trustedSourcesStep = workflow.indexOf(
      "- name: Verify trusted autofix sources",
    );
    const pushStep = workflow.indexOf("- name: Push autofixes");

    expect(workflow).toContain(
      "name: autofix.ci # autofix.ci uses this exact name as a security boundary",
    );
    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("secrets.");

    expect(workflow).toContain("github.actor == 'dependabot[bot]'");
    expect(workflow).toContain(
      "github.event.pull_request.user.login == 'dependabot[bot]'",
    );
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(workflow).toContain(
      "startsWith(github.event.pull_request.head.ref, 'dependabot/bun/')",
    );
    expect(workflow).toContain(
      `ref: \${{ github.event.pull_request.head.sha }}`,
    );
    expect(workflow).toContain("persist-credentials: false");

    expect(workflow).toContain(
      "bun --no-env-file dedupe --lockfile-only --ignore-scripts",
    );
    expect(workflow).toContain(
      `git diff --name-only "$HEAD_SHA" -- . ':(exclude)bun.lock' ":(exclude)$EMPTY_CHANGESET_PATH"`,
    );
    expect(workflow).toContain(
      `git ls-files --others --exclude-standard -- . ":(exclude)$EMPTY_CHANGESET_PATH"`,
    );
    expect(restrictionStep).toBeGreaterThanOrEqual(0);
    expect(trustedSourcesStep).toBeGreaterThanOrEqual(0);
    expect(restrictionStep).toBeGreaterThan(trustedSourcesStep);
    expect(pushStep).toBeGreaterThan(restrictionStep);
    expect(workflow).toContain(
      "autofix-ci/action@c5b2d67aa2274e7b5a18224e8171550871fc7e4a # v1.3.4",
    );
    expect(workflow).toContain("- name: Verify trusted autofix sources");
    expect(workflow).toContain(`git diff --quiet "$BASE_SHA" "$HEAD_SHA" --`);
    expect(workflow).toContain(
      `if [[ "$(git rev-parse HEAD)" != "$HEAD_SHA" ]]; then`,
    );
    expect(workflow).toContain(
      "bun --no-install --no-env-file scripts/dependabot-empty-changeset.ts",
    );

    const [helper, helperTest, changesetGuard] = await Promise.all([
      Bun.file(HELPER_URL).text(),
      Bun.file(HELPER_TEST_URL).text(),
      Bun.file(CHANGESET_GUARD_URL).text(),
    ]);
    expect(helper).not.toContain('from "better-result"');
    expect(changesetGuard).not.toContain('from "better-result"');
    const externalTestImports = [...helperTest.matchAll(/from "([^"]+)"/gu)]
      .flatMap((match) => {
        const specifier = match.at(1);
        return specifier === undefined ? [] : [specifier];
      })
      .filter(
        (specifier) =>
          specifier !== "bun:test" &&
          !specifier.startsWith("node:") &&
          !specifier.startsWith("."),
      );
    expect(externalTestImports).toEqual([]);
  });

  test("adds a deterministic empty changeset for published dev dependency updates", async () => {
    const workflow = await Bun.file(WORKFLOW_URL).text();
    const changesetStep = workflow.indexOf(
      "- name: Add missing empty dev dependency changeset",
    );
    const restrictionStep = workflow.indexOf(
      "- name: Restrict generated changes",
    );
    const pushStep = workflow.indexOf("- name: Push autofixes");

    expect(workflow).toContain('- "packages/*/package.json"');
    expect(workflow).not.toContain('- "packages/ui/**"');
    expect(workflow).toContain(
      `EMPTY_CHANGESET_PATH: .changeset/dependabot-dev-dependencies-\${{ github.event.pull_request.number }}.md`,
    );
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain(
      "bun --no-install --no-env-file scripts/dependabot-empty-changeset.ts",
    );
    expect(workflow).toContain(
      `--base "$BASE_SHA" --head "$HEAD_SHA" --output "$EMPTY_CHANGESET_PATH"`,
    );
    expect(workflow).toContain(
      `cmp -s <(printf '%s\\n' "---" "---") "$EMPTY_CHANGESET_PATH"`,
    );
    expect(workflow).toContain(`":(exclude)$EMPTY_CHANGESET_PATH"`);
    expect(changesetStep).toBeGreaterThanOrEqual(0);
    expect(restrictionStep).toBeGreaterThan(changesetStep);
    expect(pushStep).toBeGreaterThan(restrictionStep);
  });
});
