import { describe as context, expect, test as check } from "bun:test";

import {
  firstCollectionFailure,
  gatingWorkflowJobs,
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

  check("reports the first package collection edge", () => {
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
  });

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
});
