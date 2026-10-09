import { describe as context, expect, test as check } from "bun:test";

import {
  firstCollectionFailure,
  packageTestCollectionFailure,
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
        if (!process.env.REMOTE_URL) return;
      });
      beforeAll(() => {
        if (!process.env.REMOTE_URL) return;
      });
    `;
      expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
        { identity: "fixture.test.ts::environment return", type: "disabled" },
        { identity: "fixture.test.ts::hook:beforeAll", type: "disabled" },
        {
          identity: "fixture.test.ts::<dynamic title at 4:7>",
          type: "only",
        },
        { identity: "fixture.test.ts::focused", type: "only" },
      ]);
    },
  );

  check("exempts only registrations controlled by a managed gate", () => {
    const source = `
      const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
      describe.skipIf(!runPostgres)("managed suite", () => {
        test("managed test", () => {});
      });
      test.skip("unrelated skip", () => {});
    `;
    expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
      {
        identity: "fixture.test.ts::managed suite",
        managedServiceGate: "STELLA_RUN_POSTGRES_TESTS",
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
        "apps/web/e2e/unconfigured/example.spec.ts",
        new Set(),
        new Set(["apps/web/e2e/specs"]),
      ),
    ).toBe("runner glob: no Playwright config testDir includes the file");
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
});
