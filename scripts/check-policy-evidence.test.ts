import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkPolicyEvidence } from "./check-policy-evidence";

const testRoots: string[] = [];

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const createFixture = ({
  evidenceSource = "export const authMacro = true;",
  marker = "auth-boundary",
}: {
  evidenceSource?: string;
  marker?: string;
} = {}) => {
  const root = mkdtempSync(join(tmpdir(), "stella-policy-evidence-"));
  testRoots.push(root);
  mkdirSync(join(root, "docs/policies"), { recursive: true });
  mkdirSync(join(root, "apps/api/src/lib"), { recursive: true });
  writeFileSync(
    join(root, "docs/policies/access-control.md"),
    `# Access control\n\n<!-- evidence: ${marker} -->\n`,
  );
  writeFileSync(join(root, "apps/api/src/lib/auth.ts"), evidenceSource);
  writeFileSync(
    join(root, "docs/policies/evidence.json"),
    JSON.stringify({
      version: 1,
      controls: [
        {
          id: "auth-boundary",
          policy: "docs/policies/access-control.md",
          evidence: [
            {
              path: "apps/api/src/lib/auth.ts",
              contains: ["export const authMacro"],
            },
          ],
        },
      ],
    }),
  );
  return root;
};

describe("policy evidence guard", () => {
  test("accepts a policy marker backed by matching source evidence", () => {
    const result = checkPolicyEvidence({ rootDir: createFixture() });
    expect(result.errors).toEqual([]);
  });

  test("reports implementation drift at the missing source assertion", () => {
    const root = createFixture({
      evidenceSource: "export const other = true;",
    });
    const result = checkPolicyEvidence({ rootDir: root });
    expect(result.errors).toContain(
      'auth-boundary: apps/api/src/lib/auth.ts no longer contains "export const authMacro"',
    );
  });

  test("reports policy markers that are stale or unregistered", () => {
    const root = createFixture({ marker: "removed-control" });
    const result = checkPolicyEvidence({ rootDir: root });
    expect(result.errors).toContain(
      "auth-boundary: docs/policies/access-control.md is missing <!-- evidence: auth-boundary -->",
    );
    expect(result.errors).toContain(
      "docs/policies/access-control.md references unknown evidence control removed-control",
    );
  });

  test("rejects evidence paths outside the repository", () => {
    const root = createFixture();
    const manifestPath = join(root, "docs/policies/evidence.json");
    const manifest = readFileSync(manifestPath, "utf8").replace(
      "apps/api/src/lib/auth.ts",
      "../../outside.txt",
    );
    writeFileSync(manifestPath, manifest);

    const result = checkPolicyEvidence({ rootDir: root });
    expect(result.errors).toContain(
      "controls[0].evidence[0].path must be a repository-relative path",
    );
  });
});
