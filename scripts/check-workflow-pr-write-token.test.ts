import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  checkWorkflowPrivilegeSource,
  parsesAsCondition,
  unusedWorkflowPrivilegeExemptions,
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
    for (const [entry, { reason }] of Object.entries(
      WORKFLOW_PRIVILEGE_ALLOWLIST,
    )) {
      expect(entry).toMatch(/^\.github\/workflows\/[^:]+:[^:]+$/u);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
  test("every allowlist entry states its condition and pins named privileges", () => {
    for (const exemption of Object.values(WORKFLOW_PRIVILEGE_ALLOWLIST)) {
      const { requires, privileges } = exemption;
      if ("unconditional" in requires) {
        expect(requires.unconditional.length).toBeGreaterThan(20);
      } else {
        expect(requires.conjuncts.length).toBeGreaterThan(0);
        for (const fragment of requires.conjuncts) {
          expect(parsesAsCondition(fragment)).toBeTrue();
        }
      }
      for (const name of [...privileges.write, ...privileges.secrets]) {
        expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/u);
        expect(name).not.toBe("inherit");
      }
      if ("calls" in exemption) {
        expect(exemption.calls).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
      }
    }
    // A job pattern applies only to jobs calling its pinned workflow.
    for (const [entry, exemption] of Object.entries(
      WORKFLOW_PRIVILEGE_ALLOWLIST,
    )) {
      if (entry.endsWith("*")) {
        expect("calls" in exemption, entry).toBeTrue();
      }
    }
  });
  test("every allowlist entry still matches a finding and privilege of its job", () => {
    expect(
      unusedWorkflowPrivilegeExemptions(
        path.resolve(import.meta.dirname, ".."),
      ),
    ).toEqual([]);
  });
  test("an exemption covers only its approved findings", () => {
    const source = `
on: pull_request_target
permissions:
  contents: write
jobs:
  ci-plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@pin
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: bash scripts/x.sh`;
    expect(
      checkWorkflowPrivilegeSource(".github/workflows/ci.yml", source),
    ).not.toHaveLength(0);
  });
  test("an exemption lapses when the job drops a condition its reason needs", () => {
    const source = (condition: string) => `
on: pull_request
permissions:
  actions: write
jobs:
  database-migrations-check:
    runs-on: ubuntu-latest
${condition}    steps:
      - uses: actions/checkout@pin
      - run: bash scripts/x.sh`;
    const ciFile = ".github/workflows/ci.yml";
    expect(
      checkWorkflowPrivilegeSource(
        ciFile,
        source("    if: needs.ci-plan.outputs.trusted == 'true'\n"),
      ),
    ).toEqual([]);
    expect(checkWorkflowPrivilegeSource(ciFile, source(""))).not.toHaveLength(
      0,
    );
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
  test("treats every spelling of the workspace root and expression paths as the root", () => {
    for (const checkoutPath of [
      "./",
      "untrusted/..",
      ".//",
      `\${{ env.TOOLING_DIR }}`,
    ]) {
      const body = `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: ${checkoutPath}\n      - run: bash tooling/scripts/x.sh`;
      expect(check(workflow("pull_request_target", body))).not.toHaveLength(0);
    }
  });
  test("refuses remote actions whose inputs name a head checkout", () => {
    const head = `      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}`;
    for (const body of [
      `    steps:\n${head}\n          path: untrusted\n      - uses: docker/build-push-action@pin\n        with:\n          context: untrusted`,
      `    steps:\n${head}\n      - uses: docker/build-push-action@pin\n        with:\n          context: .`,
    ]) {
      expect(check(workflow("pull_request_target", body))).not.toHaveLength(0);
    }
    const unrelated = `    steps:\n${head}\n      - uses: actions/upload-artifact@pin\n        with:\n          name: report`;
    expect(check(workflow("pull_request_target", unrelated))).toHaveLength(0);
  });
  test("treats an expression working directory as any checkout", () => {
    const body = `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: untrusted\n      - working-directory: \${{ env.DIR }}\n        run: bash scripts/x.sh`;
    expect(check(workflow("pull_request_target", body))).not.toHaveLength(0);
  });
  test("skips consumer steps whose own condition excludes the event", () => {
    for (const condition of [
      "false",
      "github.event_name != 'pull_request_target'",
    ]) {
      const body = `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n      - if: ${condition}\n        run: bash scripts/x.sh`;
      expect(check(workflow("pull_request_target", body))).toHaveLength(0);
    }
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

const HEAD_CHECKOUT = `      - uses: actions/checkout@pin
        with:
          ref: \${{ github.event.pull_request.head.sha }}`;
const target = (steps: string, extra = "", permissions = "contents: write") =>
  check(
    workflow(
      "pull_request_target",
      `${extra}    steps:\n${steps}`,
      permissions,
    ),
  );
const CI_FILE = ".github/workflows/ci.yml";
const ciJob = (job: string, body: string, permissions = "actions: write") =>
  checkWorkflowPrivilegeSource(
    CI_FILE,
    `
on: pull_request
permissions:
  ${permissions}
jobs:
  ${job}:
    runs-on: ubuntu-latest
${body}`,
  );
const RUN_SCRIPT = `      - uses: actions/checkout@pin\n      - run: bash scripts/x.sh`;

describe("condition reading", () => {
  const stepIf = (condition: string) =>
    target(
      `${HEAD_CHECKOUT}\n      - if: ${condition}\n        run: bash scripts/x.sh`,
    );
  test("reads a condition only when one expression spans the whole value", () => {
    expect(
      stepIf(`"\${{ github.event_name != 'pull_request_target' }} "`),
    ).not.toHaveLength(0);
    expect(
      stepIf(`\${{ github.event_name != 'pull_request_target' }}`),
    ).toHaveLength(0);
  });
  test("leaves comparisons of different literal kinds undecided", () => {
    expect(stepIf(`"'1' == true"`)).not.toHaveLength(0);
    expect(stepIf(`"'push' == 'pull'"`)).toHaveLength(0);
  });
  test("reads only single-quoted strings as literals", () => {
    expect(
      stepIf(`'github.event_name != "pull_request_target"'`),
    ).not.toHaveLength(0);
    expect(stepIf("github.event_name != 'pull_request_target'")).toHaveLength(
      0,
    );
  });
  test("reads job conditions the same way", () => {
    const steps = `${HEAD_CHECKOUT}\n      - run: bash scripts/x.sh`;
    expect(target(steps, `    if: "'1' == true"\n`)).not.toHaveLength(0);
    expect(
      target(steps, `    if: github.event_name != 'pull_request_target'\n`),
    ).toHaveLength(0);
  });
});

describe("exemption binding", () => {
  const steps = `    steps:\n${RUN_SCRIPT}`;
  const migrations = (condition: string) =>
    ciJob("database-migrations-check", `    if: ${condition}\n${steps}`);
  test("requires the exemption condition as a top-level conjunct", () => {
    expect(
      migrations("always() || needs.ci-plan.outputs.trusted == 'true'"),
    ).not.toHaveLength(0);
    expect(
      migrations(`"!(needs.ci-plan.outputs.trusted == 'true')"`),
    ).not.toHaveLength(0);
    expect(
      migrations(
        "always() && (needs.ci-plan.outputs.trusted == 'true' || github.event_name == 'workflow_dispatch')",
      ),
    ).toEqual([]);
  });
  test("reports write access beyond the approved scopes", () => {
    expect(ciJob("ci-plan", steps, "contents: write")).not.toHaveLength(0);
    expect(ciJob("ci-plan", steps)).toEqual([]);
  });
  test("reports secrets beyond the approved names", () => {
    const reusable = (secrets: string) =>
      checkWorkflowPrivilegeSource(
        CI_FILE,
        `
on: pull_request
jobs:
  marketing-screenshots:
    if: needs.ci-plan.outputs.trusted == 'true'
    uses: ./.github/workflows/marketing-screenshots.yml
    secrets:${secrets}`,
      );
    expect(reusable(" inherit")).not.toHaveLength(0);
    expect(
      reusable(
        `\n      DOCKERHUB_USERNAME: \${{ secrets.DOCKERHUB_USERNAME }}\n      DOCKERHUB_TOKEN: \${{ secrets.DOCKERHUB_TOKEN }}`,
      ),
    ).toEqual([]);
  });
  test("binds a called-workflow exemption to its pinned revision", () => {
    const caller = (revision: string) =>
      checkWorkflowPrivilegeSource(
        ".github/workflows/pr-lint.yml",
        `
on: pull_request_target
permissions:
  contents: read
  pull-requests: write
jobs:
  pr-lint:
    uses: stella/.github/.github/workflows/pr-lint.yml@${revision}`,
      );
    expect(caller("main")).not.toHaveLength(0);
    expect(caller("5764ab66e4df84cfd2e642c7d7e4678261e668f8")).toEqual([]);
  });
  test("binds a job-pattern exemption to its gate, privileges and pinned call", () => {
    const gate = [
      "needs.pack.result == 'success'",
      "github.event.workflow_run.head_repository.full_name == github.repository",
      "github.event.workflow_run.path == '.github/workflows/release.yml'",
      `contains(fromJSON('["push", "workflow_dispatch"]'), github.event.workflow_run.event)`,
    ];
    const release = ({
      conjuncts = gate,
      revision = "042baebaf071329b956555c05caf5736504c278d",
      extraSecret = "",
    } = {}) =>
      checkWorkflowPrivilegeSource(
        ".github/workflows/publish-npm.yml",
        `
on:
  workflow_run:
    workflows: [Release Artifacts]
    types: [completed]
jobs:
  release-example:
    if: >-
      always() && (github.event_name != 'workflow_run' || (${conjuncts.join(" && ")}))
    permissions:
      actions: read
      contents: write
      id-token: write
    uses: stella/.github/.github/workflows/npm-independent-release.yml@${revision}
    secrets:
      RELEASE_APP_ID: \${{ secrets.STELLA_RELEASE_APP_ID }}
      RELEASE_APP_PRIVATE_KEY: \${{ secrets.STELLA_RELEASE_APP_PRIVATE_KEY }}${extraSecret}`,
      );
    expect(release()).toEqual([]);
    expect(release({ conjuncts: gate.slice(0, 2) })).not.toHaveLength(0);
    expect(release({ revision: "main" })).not.toHaveLength(0);
    expect(
      release({ extraSecret: `\n      OTHER: \${{ secrets.OTHER_KEY }}` }),
    ).not.toHaveLength(0);
  });
});

describe("checkout locations", () => {
  const checkout = (ref: string, action = "actions/checkout") =>
    target(
      `      - uses: ${action}@pin\n        with:\n          ref: ${ref}\n      - run: bash scripts/x.sh`,
    );
  test("resolves paths outside the workspace to the root", () => {
    const located = (location: string) =>
      target(
        `${HEAD_CHECKOUT}\n          path: ${location}\n      - run: bash scripts/x.sh`,
      );
    for (const location of ["../tooling", "/tmp/tooling", "~/tooling"]) {
      expect(located(location)).not.toHaveLength(0);
    }
    expect(located("tooling")).toHaveLength(0);
  });
  test("matches checkout actions case-insensitively", () => {
    expect(
      checkout(
        `\${{ github.event.pull_request.head.sha }}`,
        "Actions/Checkout",
      ),
    ).not.toHaveLength(0);
    expect(checkout("main", "Actions/Checkout")).toHaveLength(0);
  });
  test("refuses literal pull-request refs", () => {
    expect(checkout("refs/pull/1/head")).not.toHaveLength(0);
    expect(checkout("refs/heads/main")).toHaveLength(0);
  });
  test("treats commands that fetch another revision as controlling the root", () => {
    const fetch = (command: string) =>
      target(
        `      - uses: actions/checkout@pin\n      - run: ${command}\n      - run: bash scripts/x.sh`,
      );
    expect(fetch("git fetch origin refs/pull/1/head")).not.toHaveLength(0);
    expect(fetch("git status --short")).toHaveLength(0);
  });
});

describe("steps reaching a checkout", () => {
  const nested = `${HEAD_CHECKOUT}\n          path: untrusted`;
  test("counts local action inputs that name a checkout", () => {
    const local = (input: string) =>
      target(
        `${nested}\n      - uses: ./.github/actions/build\n        with:\n          directory: ${input}`,
      );
    expect(local("untrusted")).not.toHaveLength(0);
    expect(local("trusted")).toHaveLength(0);
  });
  test("counts remote actions after a root checkout unless they only store files", () => {
    const remote = (action: string) =>
      target(`${HEAD_CHECKOUT}\n      - uses: ${action}@pin`);
    expect(remote("example/lint-action")).not.toHaveLength(0);
    expect(remote("actions/cache")).toHaveLength(0);
  });
  test("counts run steps with runtime values as reaching every checkout", () => {
    const run = (command: string) =>
      target(`${nested}\n      - run: ${command}`);
    expect(run('make -C "$DIR"')).not.toHaveLength(0);
    expect(run("echo done")).toHaveLength(0);
  });
  test("counts env values that name a checkout", () => {
    const env = (value: string) =>
      target(
        `${nested}\n      - env:\n          DIR: ${value}\n        run: make`,
      );
    expect(env("untrusted")).not.toHaveLength(0);
    expect(env("trusted")).toHaveLength(0);
  });
  test("counts a working directory above a checkout", () => {
    const deeper = `${HEAD_CHECKOUT}\n          path: vendor/untrusted`;
    const run = (directory: string) =>
      target(
        `${deeper}\n      - working-directory: ${directory}\n        run: make`,
      );
    expect(run("vendor")).not.toHaveLength(0);
    expect(run("other")).toHaveLength(0);
  });
  test("counts a shell that names a checkout", () => {
    const run = (shell: string) =>
      target(`${nested}\n      - shell: ${shell}\n        run: make`);
    expect(run("untrusted/bin/sh {0}")).not.toHaveLength(0);
    expect(run("bash")).toHaveLength(0);
  });
});

describe("job privileges", () => {
  test("counts secrets referenced anywhere in the job", () => {
    const container = (value: string) =>
      target(
        `${HEAD_CHECKOUT}\n      - run: bash scripts/x.sh`,
        `    container:\n      image: node:22\n      env:\n        KEY: ${value}\n`,
        "contents: read",
      );
    expect(container(`\${{ secrets.KEY }}`)).not.toHaveLength(0);
    expect(container(`\${{ secrets.GITHUB_TOKEN }}`)).toHaveLength(0);
  });
  test("flags called workflows that receive secrets or write access", () => {
    const caller = (permissions: string, secrets = "") =>
      check(`
on: pull_request_target
${permissions}
jobs:
  example:
    uses: example/repo/.github/workflows/build.yml@pin
${secrets}`);
    expect(caller("")).not.toHaveLength(0);
    expect(
      caller("permissions:\n  contents: read", "    secrets: inherit"),
    ).not.toHaveLength(0);
    expect(caller("permissions:\n  contents: read")).toHaveLength(0);
  });
});

describe("triggers", () => {
  const secretRun = `    env:\n      KEY: \${{ secrets.KEY }}\n    steps:\n${RUN_SCRIPT}`;
  test("analyses review events like pull_request", () => {
    expect(
      check(workflow("pull_request_review", secretRun, "contents: read")),
    ).not.toHaveLength(0);
    expect(
      check(
        workflow(
          "pull_request_review",
          `    steps:\n${RUN_SCRIPT}`,
          "contents: read",
        ),
      ),
    ).toHaveLength(0);
  });
  test("analyses check events like workflow_run", () => {
    const run = (ref: string) =>
      check(
        workflow(
          "check_suite",
          `    steps:\n      - uses: actions/checkout@pin\n        with:\n          ref: ${ref}\n      - run: bash scripts/x.sh`,
        ),
      );
    expect(run(`\${{ github.event.check_suite.head_sha }}`)).not.toHaveLength(
      0,
    );
    expect(run("main")).toHaveLength(0);
  });
  test("analyses unlisted events as privileged", () => {
    expect(
      check(workflow("discussion", `    steps:\n${RUN_SCRIPT}`)),
    ).not.toHaveLength(0);
    expect(check(workflow("merge_group", secretRun))).toHaveLength(0);
  });
});
