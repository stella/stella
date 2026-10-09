import { describe as context, expect, test as check } from "bun:test";

import {
  analyzeGatingWorkflow,
  firstCollectionFailure,
  gatingWorkflowJobs,
  managedServiceRunnerFailure,
  packageTestCollectionFailure,
  packageTestExecutionFailure,
  parseTestRegistrations,
} from "./test-gate";

context("test registration census", () => {
  check(
    "resolves aliases and conditional registrations to stable titles",
    () => {
      const source = `
      import { test as verify } from "bun:test";
      const selected = enabled ? verify : verify.skip;
      if (enabled) verify("conditional statement", () => {});
      verify.todo("todo registration");
      verify.skipIf(process.env.CI)("conditional helper", () => {});
      verify.todoIf(process.env.CI)("conditional todo", () => {});
      verify.if(process.env.CI)("conditional inclusion", () => {});
      selected("conditional alias", () => {});
    `;
      expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
        { identity: "fixture.test.ts::conditional alias", type: "disabled" },
        { identity: "fixture.test.ts::conditional helper", type: "disabled" },
        {
          identity: "fixture.test.ts::conditional inclusion",
          type: "disabled",
        },
        {
          identity: "fixture.test.ts::conditional statement",
          type: "disabled",
        },
        { identity: "fixture.test.ts::conditional todo", type: "disabled" },
        { identity: "fixture.test.ts::todo registration", type: "disabled" },
      ]);
    },
  );

  check(
    "finds focused registrations and environment-keyed early returns",
    () => {
      const source = `
      const title = "dynamic focused";
      test.only("focused", () => {});
      test.only(title, () => {});
      test("environment return", () => {
        if (!process.env.CI) return;
      });
      beforeAll(() => {
        if (!process.env.CI) return;
      });
    `;
      expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
        { identity: "fixture.test.ts::environment return", type: "disabled" },
        { identity: "fixture.test.ts::hook:beforeAll", type: "disabled" },
        { identity: "fixture.test.ts::dynamic focused", type: "only" },
        { identity: "fixture.test.ts::focused", type: "only" },
      ]);
    },
  );

  check("finds focused registrations through namespace imports", () => {
    const source = `
      import * as bt from "bun:test";
      bt.test.only("focused test", () => {});
      bt.it.only("focused alias", () => {});
      bt.describe.only("focused suite", () => {});
    `;
    expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
      { identity: "fixture.test.ts::focused alias", type: "only" },
      { identity: "fixture.test.ts::focused suite", type: "only" },
      { identity: "fixture.test.ts::focused test", type: "only" },
    ]);
  });

  check("fails closed for unresolved titles on disabled registrations", () => {
    const source = `
      test.skip(getTitle(), () => {});
      test.todo(prefix + suffix, () => {});
      if (enabled) test(dynamicTitle, () => {});
    `;
    expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
      { identity: "fixture.test.ts::<dynamic title at 2:7>", type: "disabled" },
      { identity: "fixture.test.ts::<dynamic title at 3:7>", type: "disabled" },
      {
        identity: "fixture.test.ts::<dynamic title at 4:20>",
        type: "disabled",
      },
    ]);
  });

  check("exempts only registrations controlled by a managed gate", () => {
    const source = `
      const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
      describe.skipIf(!runPostgres)("managed suite", () => {
        test("managed test", () => {});
        test.skip("never runs", () => {});
      });
      test.skip("unrelated skip", () => {
        console.log(process.env.STELLA_RUN_POSTGRES_TESTS);
      });
    `;
    expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
      {
        identity: "fixture.test.ts::managed suite",
        managedServiceGate: "STELLA_RUN_POSTGRES_TESTS",
        type: "disabled",
      },
      {
        identity: "fixture.test.ts::managed suite > never runs",
        type: "disabled",
      },
      { identity: "fixture.test.ts::unrelated skip", type: "disabled" },
    ]);
  });

  check(
    "reports the first package collection edge",
    () => {
      expect(firstCollectionFailure("unowned/example.test.ts", new Set())).toBe(
        "package task: no owning package.json",
      );
      expect(
        firstCollectionFailure(
          "apps/web/e2e/staging/staging-smoke.spec.ts",
          new Set(),
        ),
      ).toBe("runner glob: web wrapper does not collect the file");
      expect(
        firstCollectionFailure(
          "apps/web/e2e/staging/staging-smoke.spec.ts",
          new Set(["apps/web/e2e/staging/staging-smoke.spec.ts"]),
        ),
      ).toBeUndefined();
      expect(
        firstCollectionFailure(
          "apps/desktop/tests/browser/theme-prepaint.playwright.spec.ts",
          new Set(),
        ),
      ).toBeUndefined();
      const fixturePackage = {
        test: "bun test src --path-ignore-patterns '**/excluded.test.ts'",
      };
      expect(
        packageTestCollectionFailure({
          candidate: "packages/fixture/src/excluded.test.ts",
          packageDirectory: "packages/fixture",
          scripts: fixturePackage,
        }),
      ).toBe("runner glob: test command excludes the file");
    },
    15_000,
  );

  check("rejects a collectable package absent from gating jobs", () => {
    const scripts = { test: "bun test" };
    expect(
      packageTestCollectionFailure({
        candidate: "packages/orphan/src/orphan.test.ts",
        packageDirectory: "packages/orphan",
        scripts,
      }),
    ).toBeUndefined();
    expect(
      packageTestExecutionFailure({
        gatingJobs: new Map([["ci-checks-rest", ["bun scripts/test-gate.ts"]]]),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set(),
      }),
    ).toBe("job condition: no gating job executes @stll/orphan test");
  });

  check("requires the gating job to invoke the exact test script", () => {
    expect(
      packageTestExecutionFailure({
        gatingJobs: new Map([
          ["package-check", ["bun --filter @stll/orphan test:smoke"]],
        ]),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set(),
      }),
    ).toBe("job condition: no gating job executes @stll/orphan test");
  });

  check("ignores package commands in statically disabled steps", () => {
    const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    steps:
      - if: \${{ false }}
        run: bun --filter @stll/orphan test
  ci-result:
    needs: [package-check]
`);
    expect(
      packageTestExecutionFailure({
        gatingJobs: gatingWorkflowJobs(workflow),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set(),
      }),
    ).toBe("job condition: no gating job executes @stll/orphan test");
  });

  check("expands matrix legs before evaluating gating events", () => {
    const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    strategy:
      matrix:
        event: [push, schedule, pull_request]
        exclude:
          - event: pull_request
    steps:
      - if: github.event_name == matrix.event
        run: bun --filter @stll/orphan test
  ci-result:
    needs: [package-check]
`);
    expect(
      packageTestExecutionFailure({
        gatingJobs: gatingWorkflowJobs(workflow),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set(),
      }),
    ).toBe("job condition: no gating job executes @stll/orphan test");
  });

  check("counts matrix include legs that can run on a gating event", () => {
    const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    strategy:
      matrix:
        event: [push]
        include:
          - event: merge_group
    steps:
      - if: github.event_name == matrix.event
        run: bun --filter @stll/orphan test
  ci-result:
    needs: [package-check]
`);
    expect(
      packageTestExecutionFailure({
        gatingJobs: gatingWorkflowJobs(workflow),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set(),
      }),
    ).toBeUndefined();
  });

  check("counts step outcomes on the successful runtime path", () => {
    const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    steps:
      - if: steps.install.outcome == 'success'
        run: bun --filter @stll/orphan test
  ci-result:
    needs: [package-check]
`);
    expect(
      packageTestExecutionFailure({
        gatingJobs: analyzeGatingWorkflow(workflow).jobs,
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set(),
      }),
    ).toBeUndefined();
  });

  check(
    "rejects failure-only step outcomes on the successful runtime path",
    () => {
      const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    steps:
      - if: steps.install.outcome == 'failure'
        run: bun --filter @stll/orphan test
  ci-result:
    needs: [package-check]
`);
      expect(
        packageTestExecutionFailure({
          gatingJobs: analyzeGatingWorkflow(workflow).jobs,
          packageDirectory: "packages/orphan",
          packageName: "@stll/orphan",
          shardedPackages: new Set(),
        }),
      ).toBe("job condition: no gating job executes @stll/orphan test");
    },
  );

  check("fails closed and names unresolved repository variables", () => {
    const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    steps:
      - if: vars.SOME_TOGGLE == 'on'
        run: bun --filter @stll/orphan test
  ci-result:
    needs: [package-check]
`);
    const analysis = analyzeGatingWorkflow(workflow);
    expect(analysis.findings).toEqual([
      "job condition: package-check/step-1 has unresolved context vars.SOME_TOGGLE",
    ]);
    expect(
      packageTestExecutionFailure({
        gatingJobs: analysis.jobs,
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set(),
      }),
    ).toBe("job condition: no gating job executes @stll/orphan test");
  });

  check("fails closed and names inputs without declared defaults", () => {
    const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    steps:
      - if: inputs.RUN_TESTS == true
        run: bun --filter @stll/orphan test
  ci-result:
    needs: [package-check]
`);
    expect(analyzeGatingWorkflow(workflow).findings).toEqual([
      "job condition: package-check/step-1 has unresolved context inputs.RUN_TESTS",
    ]);
  });

  check("accepts an exact registered default-on repository toggle", () => {
    const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    steps:
      - if: vars.QUEUE_BROWSER_SUITES != 'off'
        run: bun --filter @stll/orphan test
  ci-result:
    needs: [package-check]
`);
    const analysis = analyzeGatingWorkflow(workflow);
    expect(analysis.findings).toEqual([]);
    expect(
      packageTestExecutionFailure({
        gatingJobs: analysis.jobs,
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set(),
      }),
    ).toBeUndefined();
  });

  check("ignores a package whose only runner is push-only", () => {
    const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    if: github.event_name == 'push'
    steps:
      - run: bun --filter @stll/orphan test
  ci-result:
    needs: [package-check]
`);
    expect(
      packageTestExecutionFailure({
        gatingJobs: gatingWorkflowJobs(workflow),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set(),
      }),
    ).toBe("job condition: no gating job executes @stll/orphan test");
  });

  check("ignores package commands in steps that continue on error", () => {
    const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    steps:
      - continue-on-error: \${{ github.event_name == 'pull_request' || github.event_name == 'merge_group' }}
        run: bun --filter @stll/orphan test
  ci-result:
    needs: [package-check]
`);
    expect(
      packageTestExecutionFailure({
        gatingJobs: gatingWorkflowJobs(workflow),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set(),
      }),
    ).toBe("job condition: no gating job executes @stll/orphan test");
  });

  check("ignores package commands in jobs that continue on error", () => {
    const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    continue-on-error: true
    steps:
      - run: bun --filter @stll/orphan test
  ci-result:
    needs: [package-check]
`);
    expect(
      packageTestExecutionFailure({
        gatingJobs: gatingWorkflowJobs(workflow),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set(),
      }),
    ).toBe("job condition: no gating job executes @stll/orphan test");
  });

  check("ignores package commands in YAML comments", () => {
    const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    steps:
      - run: |
          # bun --filter @stll/orphan test
          echo no tests
  ci-result:
    needs: [package-check]
`);
    expect(
      packageTestExecutionFailure({
        gatingJobs: gatingWorkflowJobs(workflow),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set(),
      }),
    ).toBe("job condition: no gating job executes @stll/orphan test");
  });

  const managedRunnerFailure = (workflow: string) =>
    managedServiceRunnerFailure({
      command: "bun run test:postgres",
      gate: "STELLA_RUN_POSTGRES_TESTS",
      gatingJobs: gatingWorkflowJobs(Bun.YAML.parse(workflow)),
    });

  check("ignores a managed runner in a statically disabled step", () => {
    expect(
      managedRunnerFailure(`
jobs:
  service-suites:
    steps:
      - if: \${{ false }}
        run: bun run test:postgres
  ci-result:
    needs: [service-suites]
`),
    ).toBe(
      "job condition: no gating job executes the STELLA_RUN_POSTGRES_TESTS runner",
    );
  });

  check("ignores a managed runner in a push-only job", () => {
    expect(
      managedRunnerFailure(`
jobs:
  service-suites:
    if: github.event_name == 'push'
    steps:
      - run: bun run test:postgres
  ci-result:
    needs: [service-suites]
`),
    ).toBe(
      "job condition: no gating job executes the STELLA_RUN_POSTGRES_TESTS runner",
    );
  });

  check("ignores a managed runner that continues on error", () => {
    expect(
      managedRunnerFailure(`
jobs:
  service-suites:
    steps:
      - continue-on-error: true
        run: bun run test:postgres
  ci-result:
    needs: [service-suites]
`),
    ).toBe(
      "job condition: no gating job executes the STELLA_RUN_POSTGRES_TESTS runner",
    );
  });
});
