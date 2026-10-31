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
  test("refuses event-derived base tooling despite its trusted path", () => {
    expect(
      check(
        workflow(
          "pull_request_target",
          `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.event.pull_request.base.sha }}\n          path: .trusted\n      - run: .trusted/scripts/x.sh`,
        ),
      ),
    ).not.toHaveLength(0);
  });
  test("refuses pull_request_target head tooling checked out to an explicit path", () => {
    expect(
      check(
        workflow(
          "pull_request_target",
          `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: untrusted\n      - run: bash untrusted/scripts/x.sh`,
        ),
      ),
    ).not.toHaveLength(0);
    expect(
      check(
        workflow(
          "pull_request_target",
          `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: release-v1\n          path: trusted\n      - run: bash trusted/scripts/x.sh`,
        ),
      ),
    ).toHaveLength(0);
  });
  test("refuses env-indirected tooling under pull_request_target", () => {
    const body = `    env:\n      PR_HEAD: \${{ github.event.pull_request.head.sha }}\n    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ env.PR_HEAD }}\n      - run: bash scripts/x.sh`;
    expect(check(workflow("pull_request_target", body))).not.toHaveLength(0);
  });
  test("refuses interpolated refs and repositories under pull_request_target", () => {
    for (const field of [
      `ref: refs/heads/\${{ env.PR_BRANCH }}`,
      `repository: \${{ inputs.owner }}/repo`,
    ]) {
      const body = `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ${field}\n      - run: bash scripts/x.sh`;
      expect(check(workflow("pull_request_target", body))).not.toHaveLength(0);
    }
  });
  test("a conditional trusted checkout never clears an earlier head checkout", () => {
    const body = `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n      - if: false\n        uses: actions/checkout@pin\n        with:\n          ref: main\n      - run: bash scripts/x.sh`;
    expect(check(workflow("pull_request_target", body))).not.toHaveLength(0);
  });
  test("follows working directories nested inside a head checkout", () => {
    const body = `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: untrusted\n      - working-directory: untrusted/subdir\n        run: bash scripts/x.sh`;
    expect(check(workflow("pull_request_target", body))).not.toHaveLength(0);
  });
  test("treats secrets mapped into a local reusable workflow as exposed", () => {
    const source = `
on: pull_request
permissions:
  contents: read
jobs:
  example:
    uses: ./.github/workflows/child.yml
    secrets:
      token: \${{ secrets.KEY }}
`;
    expect(check(source)).not.toHaveLength(0);
  });
  test("does not trust the workflow revision on pull_request", () => {
    const body = `    env:\n      KEY: \${{ secrets.KEY }}\n    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.workflow_sha }}\n      - run: bash scripts/x.sh`;
    expect(
      check(workflow("pull_request", body, "contents: read")).some(
        (item) => item.class === "class 2",
      ),
    ).toBeTrue();
  });
  test("recognizes workspace-qualified paths into a head checkout", () => {
    const body = `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: untrusted\n      - run: bash "$GITHUB_WORKSPACE/untrusted/scripts/x.sh"`;
    expect(check(workflow("pull_request_target", body))).not.toHaveLength(0);
  });
  test("treats an empty checkout ref like an omitted one", () => {
    const body = `    env:\n      KEY: \${{ secrets.KEY }}\n    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: ''\n      - run: bash scripts/x.sh`;
    expect(
      check(workflow("pull_request", body, "contents: read")).some(
        (item) => item.class === "class 2",
      ),
    ).toBeTrue();
  });
  test("follows defaults.run.working-directory into a head checkout", () => {
    const body = `    defaults:\n      run:\n        working-directory: untrusted\n    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: untrusted\n      - run: bash scripts/x.sh`;
    expect(check(workflow("pull_request_target", body))).not.toHaveLength(0);
  });
  test("refuses a resolver script staged by an untrusted step", () => {
    const checkout = `      - id: target-base\n        run: bash "$RUNNER_TEMP/merge-target-base.sh"\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ steps.target-base.outputs.base_sha }}\n      - run: bash scripts/x.sh`;
    const impostor = `    steps:\n      - run: printf 'echo base_sha=x >> "$GITHUB_OUTPUT"' > "$RUNNER_TEMP/merge-target-base.sh"\n${checkout}`;
    expect(check(workflow("pull_request_target", impostor))).not.toHaveLength(
      0,
    );
    const staged = `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.workflow_sha }}\n          path: .workflow-tooling\n      - run: cp "$GITHUB_WORKSPACE/.workflow-tooling/scripts/merge-target-base.sh" "$RUNNER_TEMP/merge-target-base.sh"\n${checkout}`;
    expect(check(workflow("pull_request_target", staged))).toHaveLength(0);
  });
  test("compares event names case-insensitively, as Actions does", () => {
    const body = `    if: github.event_name == 'PULL_REQUEST_TARGET'\n    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n      - run: bash scripts/x.sh`;
    expect(check(workflow("pull_request_target", body))).not.toHaveLength(0);
  });
  test("refuses a head checkout entered with cd before execution", () => {
    const body = `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: untrusted\n      - run: cd untrusted && bash scripts/x.sh`;
    expect(check(workflow("pull_request_target", body))).not.toHaveLength(0);
  });
  test("trusts the comparison base only from the repository resolver", () => {
    const checkout = `      - uses: actions/checkout@pin\n        with:\n          ref: \${{ steps.target-base.outputs.base_sha }}\n      - run: bash scripts/x.sh`;
    const impostor = `    steps:\n      - id: target-base\n        run: echo "base_sha=\${{ github.event.pull_request.head.sha }}" >> "$GITHUB_OUTPUT"\n${checkout}`;
    expect(check(workflow("pull_request_target", impostor))).not.toHaveLength(
      0,
    );
    const resolver = `    steps:\n      - id: target-base\n        uses: ./.github/actions/merge-target-base\n${checkout}`;
    expect(check(workflow("pull_request_target", resolver))).toHaveLength(0);
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
  test("refuses bracket-notation secrets in pull_request branch scripts", () => {
    for (const secret of [
      "secrets['KEY']",
      'secrets["KEY"]',
      "secrets[ 'KEY' ]",
      "secrets . KEY",
      "SECRETS.KEY",
      "secrets[matrix.secret]",
      "secrets[format('{0}', 'KEY')]",
      "fromJSON(toJSON(secrets)).KEY",
      "secrets.GITHUB_TOKEN_EXTRA",
    ]) {
      const body = `    steps:\n      - uses: actions/checkout@pin\n      - env:\n          KEY: \${{ ${secret} }}\n        run: bash scripts/x.sh`;
      expect(
        check(workflow("pull_request", body, "contents: read")).some(
          (item) => item.class === "class 2",
        ),
      ).toBeTrue();
    }
  });
  test("refuses secrets used directly in with and run", () => {
    for (const body of [
      `    steps:\n      - uses: actions/checkout@pin\n      - run: echo \${{ toJSON(secrets) }}`,
      `    steps:\n      - uses: actions/checkout@pin\n      - uses: ./action\n        with:\n          token: \${{ secrets['KEY'] }}`,
    ]) {
      expect(
        check(workflow("pull_request", body, "contents: read")).some(
          (item) => item.class === "class 2",
        ),
      ).toBeTrue();
    }
  });
  test("refuses pull_request branch scripts with a workflow-level secret", () => {
    const source = `
on: pull_request
permissions:
  contents: read
env:
  TOKEN: \${{ secrets.X }}
jobs:
  example:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@pin
      - run: bash scripts/x.sh`;
    expect(check(source)).not.toHaveLength(0);
  });
  test("accepts pull_request branch scripts with only a write GITHUB_TOKEN", () => {
    const source = workflow(
      "pull_request",
      `    if: github.actor != 'dependabot[bot]'\n    env:\n      TOKEN: \${{ secrets.GITHUB_TOKEN }}\n    steps:\n      - uses: actions/checkout@pin\n      - run: bash scripts/x.sh`,
    );
    expect(check(source)).toHaveLength(0);
  });
  test("treats every spelling of the workflow token as the token", () => {
    for (const token of [
      "secrets[ 'GITHUB_TOKEN' ]",
      "secrets . github_token",
      "secrets.GITHUB_TOKEN }} and ${{ github.sha",
    ]) {
      const body = `    steps:\n      - uses: actions/checkout@pin\n      - env:\n          TOKEN: \${{ ${token} }}\n        run: bash scripts/x.sh`;
      expect(check(workflow("pull_request", body, "contents: read"))).toEqual(
        [],
      );
    }
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
  test("accepts tooling pinned to the workflow revision of base-branch events", () => {
    const body = `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.workflow_sha }}\n      - run: bash scripts/x.sh`;
    expect(check(workflow("pull_request_target", body))).toHaveLength(0);
  });
  test("accepts literal refs", () => {
    for (const ref of ["main", "v1.2.3"]) {
      const body = `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: ${ref}\n      - run: bash scripts/x.sh`;
      expect(check(workflow("pull_request_target", body))).toHaveLength(0);
    }
  });
  test("accepts github.sha only when the event makes it the base", () => {
    const body = `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.sha }}\n      - run: bash scripts/x.sh`;
    expect(check(workflow("pull_request_target", body))).toHaveLength(0);
    expect(check(workflow("pull_request", body))).not.toHaveLength(0);
  });
  test("refuses repositories outside the expression allowlist", () => {
    const body = `    steps:\n      - uses: actions/checkout@pin\n        with:\n          repository: \${{ inputs.repository }}\n          ref: main\n      - run: bash scripts/x.sh`;
    expect(check(workflow("pull_request_target", body))).not.toHaveLength(0);
  });
  test("accepts the current repository expression", () => {
    const body = `    steps:\n      - uses: actions/checkout@pin\n        with:\n          repository: \${{ github.repository }}\n          ref: \${{ github.workflow_sha }}\n      - run: bash scripts/x.sh`;
    expect(check(workflow("pull_request_target", body))).toHaveLength(0);
  });
  test("does not accept a substring event exclusion inside an always-true disjunction", () => {
    const body = `    if: github.event_name != 'pull_request' || true
    env:
      KEY: \${{ secrets.KEY }}
    steps:
      - uses: actions/checkout@pin
      - run: bash scripts/x.sh`;
    expect(
      check(workflow("pull_request", body, "contents: read")),
    ).not.toHaveLength(0);
  });
  test("accepts a conjunctive event exclusion", () => {
    const body = `    if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'
    env:
      KEY: \${{ secrets.KEY }}
    steps:
      - uses: actions/checkout@pin
      - run: bash scripts/x.sh`;
    expect(
      check(workflow("pull_request", body, "contents: read")),
    ).toHaveLength(0);
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
