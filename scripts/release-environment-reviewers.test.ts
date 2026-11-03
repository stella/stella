import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const check = (rules: unknown[]) => {
  const root = mkdtempSync(path.join(tmpdir(), "release-environment-"));
  try {
    const response = {
      deployment_branch_policy: {
        custom_branch_policies: true,
        protected_branches: false,
      },
      protection_rules: rules,
    };
    writeFileSync(path.join(root, "response.json"), JSON.stringify(response));
    writeFileSync(
      path.join(root, "gh.sh"),
      '#!/usr/bin/env bash\ncat "$TEST_RESPONSE"\n',
    );
    return Bun.spawnSync(
      [
        "bash",
        new URL("check-release-environment.sh", import.meta.url).pathname,
        "stella/stella",
      ],
      {
        env: {
          ...process.env,
          GH_RETRY_SCRIPT: path.join(root, "gh.sh"),
          TEST_RESPONSE: path.join(root, "response.json"),
        },
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
test("release-app keeps only a deployment branch policy", () => {
  const result = check([{ type: "branch_policy" }]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
for (const rule of [
  "required_reviewers",
  "wait_timer",
  "custom_deployment_protection_rule",
]) {
  test(`${rule} cannot introduce an approval wait into the release path`, () => {
    const result = check([{ type: "branch_policy" }, { type: rule }]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "release-app must retain only its branch policy",
    );
  });
}
