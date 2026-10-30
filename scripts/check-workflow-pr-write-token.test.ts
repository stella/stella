import { describe, expect, test } from "bun:test";

import {
  checkWorkflowPrivilegeSource,
  WORKFLOW_PRIVILEGE_ALLOWLIST,
} from "./check-workflow-pr-write-token";

const workflow = (
  on: string,
  body: string,
  permissions = "contents: write",
) => `
on: ${on}
permissions:
  ${permissions}
jobs:
  example:
    runs-on: ubuntu-latest
${body}`;
const check = (source: string) =>
  checkWorkflowPrivilegeSource("fixture.yml", source);

describe("privileged workflow policy", () => {
  test("every allowlist entry has a reachability reason", () => {
    for (const [entry, reason] of Object.entries(
      WORKFLOW_PRIVILEGE_ALLOWLIST,
    )) {
      expect(entry).toMatch(/^\.github\/workflows\/[^:]+:[^:]+$/u);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
  test("refuses pull_request_target head tooling with write access", () => {
    expect(
      check(
        workflow(
          "pull_request_target",
          `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n      - run: bash scripts/x.sh`,
        ),
      ),
    ).not.toHaveLength(0);
  });
  test("accepts base tooling in its own trusted path", () => {
    expect(
      check(
        workflow(
          "pull_request_target",
          `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.event.pull_request.base.sha }}\n          path: .trusted\n      - run: .trusted/scripts/x.sh`,
        ),
      ),
    ).toHaveLength(0);
  });
  test("refuses workflow_run artifacts executed with a secret", () => {
    const source = workflow(
      "workflow_run",
      `    env:\n      KEY: \${{ secrets.KEY }}\n    steps:\n      - uses: actions/download-artifact@pin\n        with:\n          run-id: \${{ github.event.workflow_run.id }}\n      - run: ./artifact/run.sh`,
      "contents: read",
    );
    expect(check(source).some((item) => item.class === "class 1")).toBeTrue();
  });
  test("refuses pull_request branch scripts with a repository secret", () => {
    const source = workflow(
      "pull_request",
      `    env:\n      KEY: \${{ secrets.KEY }}\n    steps:\n      - uses: actions/checkout@pin\n      - run: bash scripts/x.sh`,
      "contents: read",
    );
    expect(check(source).some((item) => item.class === "class 2")).toBeTrue();
  });
  test("accepts pull_request branch scripts with only a write GITHUB_TOKEN", () => {
    const source = workflow(
      "pull_request",
      `    if: github.actor != 'dependabot[bot]'\n    env:\n      TOKEN: \${{ secrets.GITHUB_TOKEN }}\n    steps:\n      - uses: actions/checkout@pin\n      - run: bash scripts/x.sh`,
    );
    expect(check(source)).toHaveLength(0);
  });
  test("refuses Dependabot secrets unless Dependabot is excluded", () => {
    const body = `    env:\n      KEY: \${{ secrets.DEPENDABOT_KEY }}\n    steps:\n      - uses: actions/checkout@pin\n      - run: bash scripts/x.sh`;
    expect(
      check(workflow("pull_request", body, "contents: read")).some(
        (item) => item.class === "class 3",
      ),
    ).toBeTrue();
    expect(
      check(
        workflow(
          "pull_request",
          `    if: github.actor != 'dependabot[bot]'\n${body}`,
          "contents: read",
        ),
      ).some((item) => item.class === "class 3"),
    ).toBeFalse();
  });
  test("requires a main-only guard for workflow revision tooling", () => {
    const body = `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.workflow_sha }}\n      - run: bash scripts/x.sh`;
    expect(
      check(workflow("pull_request", body)).some(
        (item) => item.class === "main-only guard",
      ),
    ).toBeTrue();
  });
  test("ignores push and schedule workflows", () => {
    for (const trigger of ["push", "schedule"]) {
      expect(
        check(
          workflow(
            trigger,
            `    env:\n      KEY: \${{ secrets.KEY }}\n    steps:\n      - uses: actions/checkout@pin\n      - run: bash scripts/x.sh`,
          ),
        ),
      ).toHaveLength(0);
    }
  });
});
