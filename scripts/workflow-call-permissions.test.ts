import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { workflowCallPermissionGaps } from "./workflow-call-permissions";

const withWorkflows = (files: Record<string, string>) => {
  const dir = mkdtempSync(path.join(tmpdir(), "workflow-call-permissions-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), source);
    }
    return workflowCallPermissionGaps(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const callee = (permissions: string) => `
on: workflow_call
jobs:
  plan:
    runs-on: ubuntu-latest
    permissions: ${permissions}
    steps:
      - run: "true"
`;

const caller = (permissions: string) => `
on: push
jobs:
  suites:
    uses: ./.github/workflows/callee.yml
    permissions: ${permissions}
`;

describe("workflow call permissions", () => {
  test("every local reusable workflow call grants what its callee requests", () => {
    const { calls, gaps } = workflowCallPermissionGaps(
      path.join(import.meta.dirname, "../.github/workflows"),
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(gaps).toEqual([]);
  });

  test("reports a callee job scope the caller does not grant", () => {
    const { gaps } = withWorkflows({
      "callee.yml": callee("{ contents: read, statuses: write }"),
      "caller.yml": caller("{ contents: read }"),
    });
    expect(gaps).toEqual([
      {
        caller: "caller.yml#suites",
        callee: "./.github/workflows/callee.yml#plan",
        scope: "statuses",
        granted: "none",
        requested: "write",
      },
    ]);
  });

  test("reports a write request under a read grant", () => {
    const { gaps } = withWorkflows({
      "callee.yml": callee("{ statuses: write }"),
      "caller.yml": caller("{ statuses: read }"),
    });
    expect(gaps.map(({ scope, granted }) => [scope, granted])).toEqual([
      ["statuses", "read"],
    ]);
  });

  test("checks the callee's workflow-level permissions", () => {
    const { gaps } = withWorkflows({
      "callee.yml": `
on: workflow_call
permissions:
  pull-requests: write
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - run: "true"
`,
      "caller.yml": caller("{ pull-requests: read }"),
    });
    expect(gaps.map(({ callee: where }) => where)).toEqual([
      "./.github/workflows/callee.yml#workflow",
    ]);
  });

  test("falls back to the caller's workflow-level grant", () => {
    const { gaps } = withWorkflows({
      "callee.yml": callee("{ statuses: write }"),
      "caller.yml": `
on: push
permissions:
  statuses: write
jobs:
  suites:
    uses: ./.github/workflows/callee.yml
`,
    });
    expect(gaps).toEqual([]);
  });

  test("a caller without any permissions block grants nothing", () => {
    const { gaps } = withWorkflows({
      "callee.yml": callee("{ contents: read }"),
      "caller.yml": `
on: push
jobs:
  suites:
    uses: ./.github/workflows/callee.yml
`,
    });
    expect(gaps.map(({ scope }) => scope)).toEqual(["contents"]);
  });

  test("read-all and write-all grants and requests", () => {
    expect(
      withWorkflows({
        "callee.yml": callee("{ statuses: write }"),
        "caller.yml": caller("write-all"),
      }).gaps,
    ).toEqual([]);
    expect(
      withWorkflows({
        "callee.yml": callee("{ statuses: write }"),
        "caller.yml": caller("read-all"),
      }).gaps.map(({ granted }) => granted),
    ).toEqual(["read"]);
    expect(
      withWorkflows({
        "callee.yml": callee("read-all"),
        "caller.yml": caller("{ contents: read }"),
      }).gaps.map(({ scope }) => scope),
    ).toEqual(["read-all"]);
    expect(
      withWorkflows({
        "callee.yml": callee("{}"),
        "caller.yml": caller("{}"),
      }).gaps,
    ).toEqual([]);
  });

  test("ignores remote reusable workflows and plain jobs", () => {
    const { calls } = withWorkflows({
      "caller.yml": `
on: push
jobs:
  remote:
    uses: example/workflows/.github/workflows/x.yml@0123456789abcdef0123456789abcdef01234567
  build:
    runs-on: ubuntu-latest
    steps:
      - run: "true"
`,
    });
    expect(calls).toEqual([]);
  });

  test("rejects an unknown permission level", () => {
    expect(() =>
      withWorkflows({
        "callee.yml": callee("{ statuses: admin }"),
        "caller.yml": caller("{ statuses: write }"),
      }),
    ).toThrow("unexpected permission level admin");
  });
});
