import { describe as context, expect, test as check } from "bun:test";
import { readFileSync } from "node:fs";

import {
  analyzeGatingWorkflow,
  firstCollectionFailure,
  gatingPlaywrightCollection,
  gatingWorkflowJobs,
  managedServiceRunnerFailure,
  packageTestCollectionFailure,
  packageTestExecutionFailure,
  parseTestRegistrations,
  rootCommandExecutionFailure,
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

  check.each([
    ["test", "test.only"],
    ["test.only", "test"],
    ["describe", "describe.only"],
  ])(
    "finds focus in either conditional alias branch: %s / %s",
    (whenTrue, whenFalse) => {
      const source = `
      const selected = enabled ? ${whenTrue} : ${whenFalse};
      selected("conditional focus", () => {});
    `;
      expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
        { identity: "fixture.test.ts::conditional focus", type: "disabled" },
        { identity: "fixture.test.ts::conditional focus", type: "only" },
      ]);
    },
  );

  check("preserves focus through nested conditional aliases", () => {
    const source = `
      const inner = enabled ? test : test.only;
      const selected = other ? test : inner;
      selected("nested focus", () => {});
    `;
    expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
      { identity: "fixture.test.ts::nested focus", type: "disabled" },
      { identity: "fixture.test.ts::nested focus", type: "only" },
    ]);
  });

  check.each(["&&", "||", "??"])(
    "inventories short-circuit registrations: %s",
    (operator) => {
      expect(
        parseTestRegistrations(
          "fixture.test.ts",
          `
      flags.runTests ${operator} test("conditional", () => {});
      enabled ${operator} describe("suite", () => { test("nested", () => {}); });
      test("always", () => {}) ${operator} other();
    `,
        ),
      ).toEqual([
        { identity: "fixture.test.ts::conditional", type: "disabled" },
        { identity: "fixture.test.ts::suite", type: "disabled" },
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

  check("inspects callbacks before trailing timeouts and suite options", () => {
    const source = `
      test("timed environment return", async () => {
        if (!process.env.CI) return;
      }, 60_000);
      beforeAll(() => { if (!process.env.CI) return; }, 60_000);
      describe("suite with options", () => {
        test.skip("nested skip", () => {});
      }, { timeout: 60_000 });
    `;
    expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
      { identity: "fixture.test.ts::hook:beforeAll", type: "disabled" },
      {
        identity: "fixture.test.ts::suite with options > nested skip",
        type: "disabled",
      },
      {
        identity: "fixture.test.ts::timed environment return",
        type: "disabled",
      },
    ]);
  });

  check(
    "enclosing service gates do not exempt independently disabled callees",
    () => {
      const source = `
      const runPostgres = process.env.STELLA_RUN_POSTGRES_TESTS === "true";
      if (runPostgres) {
        test("controlled", () => {});
        test.skip("permanent skip", () => {});
        test.todo("permanent todo");
        test.skipIf(otherFlag)("unrelated condition", () => {});
        test("environment return", () => { if (!process.env.CI) return; });
      }
    `;
      expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
        {
          identity: "fixture.test.ts::controlled",
          managedServiceGate: "STELLA_RUN_POSTGRES_TESTS",
          type: "disabled",
        },
        { identity: "fixture.test.ts::environment return", type: "disabled" },
        { identity: "fixture.test.ts::permanent skip", type: "disabled" },
        { identity: "fixture.test.ts::permanent todo", type: "disabled" },
        { identity: "fixture.test.ts::unrelated condition", type: "disabled" },
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

  check("runner utilities inside conditions are not test registrations", () => {
    const source = `
      import { test } from "@playwright/test";
      test("screenshots", async () => {
        if (language === "en") {
          await page.screenshot({ path: test.info().outputPath(dynamicPath) });
        }
      });
      if (configured) test.use({ locale: language });
    `;
    expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([]);
  });

  check("managed gates control registrations with unresolved titles", () => {
    const source = `
      const runPostgres = process.env.STELLA_RUN_POSTGRES_TESTS === "true";
      if (runPostgres) test(getTitle(), () => {});
    `;
    expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
      {
        identity: "fixture.test.ts::<dynamic title at 3:24>",
        managedServiceGate: "STELLA_RUN_POSTGRES_TESTS",
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
    "inverse managed-service conditions remain in the disabled inventory",
    () => {
      const source = `
      const runPostgres = process.env.STELLA_RUN_POSTGRES_TESTS === "true";
      test.skipIf(runPostgres)("inverse skip helper", () => {});
      if (!runPostgres) test("inverse branch", () => {});
    `;
      expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
        { identity: "fixture.test.ts::inverse branch", type: "disabled" },
        { identity: "fixture.test.ts::inverse skip helper", type: "disabled" },
      ]);
    },
  );

  check.each([
    [
      'test.skipIf((runPostgres && "disabled") === "disabled")("registration", () => {});',
      false,
    ],
    [
      'const selected = runPostgres ? test : test.skip; selected("registration", () => {});',
      true,
    ],
    [
      'const selected = runPostgres ? test.skip : test; selected("registration", () => {});',
      false,
    ],
    ['test.skipIf(!runPostgres)("registration", () => {});', true],
    ['test.todoIf(!runPostgres)("registration", () => {});', true],
    ['test.if(runPostgres)("registration", () => {});', true],
    ['if (!runPostgres) {} else test("registration", () => {});', true],
    ['if (disabled) test("registration", () => {});', false],
    ['test.skipIf(!disabled)("registration", () => {});', false],
    ['test.todoIf(runPostgres)("registration", () => {});', false],
    ['test.if(!runPostgres)("registration", () => {});', false],
    [
      'if (runPostgres) { if (!runPostgres) test("registration", () => {}); }',
      false,
    ],
    [
      'if (!runPostgres) { test.skipIf(!runPostgres)("registration", () => {}); }',
      false,
    ],
    ['if (runPostgres && otherFlag) test("registration", () => {});', false],
    [
      'if (runPostgres) { if (otherFlag) test("registration", () => {}); }',
      false,
    ],
    [
      'test.skipIf(!runPostgres).skipIf(otherFlag)("registration", () => {});',
      false,
    ],
    [
      'if (runPostgres) { otherFlag && test("registration", () => {}); }',
      false,
    ],
    [
      'if (runPostgres) { runPostgres && test("registration", () => {}); }',
      true,
    ],
    ['if (runPostgres) { disabled || test("registration", () => {}); }', true],
    [
      'if (runPostgres) { otherFlag || test("registration", () => {}); }',
      false,
    ],
    [
      'if (runPostgres) { otherFlag ?? test("registration", () => {}); }',
      false,
    ],
  ] as const)(
    "establishes the active service path for %s",
    (registration, active) => {
      const source = `
      const runPostgres = process.env.STELLA_RUN_POSTGRES_TESTS === "true";
      const disabled = !runPostgres;
      ${registration}
    `;
      expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
        {
          identity: "fixture.test.ts::registration",
          type: "disabled",
          ...(active
            ? { managedServiceGate: "STELLA_RUN_POSTGRES_TESTS" }
            : {}),
        },
      ]);
    },
  );

  check(
    "reports the first package collection edge",
    () => {
      expect(
        firstCollectionFailure({
          file: "unowned/example.test.ts",
          nonGatingFiles: new Set(),
        }),
      ).toBe("package task: no owning package.json");
      expect(
        firstCollectionFailure({
          file: "apps/web/e2e/staging/staging-smoke.spec.ts",
          nonGatingFiles: new Set(),
        }),
      ).toBe("runner glob: web wrapper does not collect the file");
      expect(
        firstCollectionFailure({
          file: "apps/web/e2e/staging/staging-smoke.spec.ts",
          nonGatingFiles: new Set([
            "apps/web/e2e/staging/staging-smoke.spec.ts",
          ]),
        }),
      ).toBeUndefined();
      expect(
        firstCollectionFailure({
          file: "apps/desktop/tests/browser/theme-prepaint.playwright.spec.ts",
          nonGatingFiles: new Set(),
        }),
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

  check(
    "a package script runner whose failure cannot propagate collects nothing",
    () => {
      for (const test of [
        "bun test src | cat",
        "bun test src &",
        "bun test src; echo done",
      ]) {
        expect(
          packageTestCollectionFailure({
            candidate: "packages/fixture/src/a.test.ts",
            packageDirectory: "packages/fixture",
            scripts: { test },
          }),
          test,
        ).toBe(
          "runner command: test script does not invoke a gating test runner",
        );
      }
      expect(
        packageTestCollectionFailure({
          candidate: "packages/fixture/src/a.test.ts",
          packageDirectory: "packages/fixture",
          scripts: { test: "true && bun test src" },
        }),
      ).toBeUndefined();
      expect(
        packageTestCollectionFailure({
          candidate: "packages/fixture/src/a.test.ts",
          packageDirectory: "packages/fixture",
          scripts: { test: "echo start; bun test src && echo done" },
        }),
      ).toBeUndefined();
    },
  );

  check("credits a file collected only by a later runner", () => {
    for (const scripts of [
      { test: "bun test src/unit && bun test src/integration" },
      {
        test: "bun run test:unit && bun run test:integration",
        "test:unit": "bun test src/unit",
        "test:integration": "bun test src/integration",
      },
    ]) {
      const failure = (candidate: string) =>
        packageTestCollectionFailure({
          candidate,
          packageDirectory: "packages/fixture",
          scripts,
        });
      expect(failure("packages/fixture/src/unit/a.test.ts")).toBeUndefined();
      expect(
        failure("packages/fixture/src/integration/b.test.ts"),
      ).toBeUndefined();
      expect(failure("packages/fixture/src/other/c.test.ts")).toBeDefined();
    }
  });

  check.each([";", "&&", "||", "&", "|", "(", ")"])(
    "quoted operator selectors remain arguments: %s",
    (operator) => {
      for (const scripts of [
        { test: `bun test '${operator}'` },
        { test: `bun run test:unit '${operator}'`, "test:unit": "bun test" },
      ]) {
        expect(
          packageTestCollectionFailure({
            candidate: "packages/fixture/src/other.test.ts",
            packageDirectory: "packages/fixture",
            scripts,
          }),
        ).toBe("runner glob: test command does not collect the file");
        expect(
          packageTestCollectionFailure({
            candidate: `packages/fixture/src/${operator}/selected.test.ts`,
            packageDirectory: "packages/fixture",
            scripts,
          }),
        ).toBeUndefined();
      }
      expect(
        packageTestExecutionFailure({
          gatingJobs: new Map([
            ["checks", [`bun --filter @stll/fixture test -- '${operator}'`]],
          ]),
          packageDirectory: "packages/fixture",
          packageName: "@stll/fixture",
          shardedPackages: new Set<string>(),
          collection: {
            candidate: "packages/fixture/src/other.test.ts",
            scripts: { test: "bun test" },
          },
        }),
      ).toContain("runner glob: test command does not collect the file");
    },
  );

  check("root script bodies keep package-script failure propagation", () => {
    const failure = (body: string) =>
      packageTestExecutionFailure({
        rootScripts: { check: body },
        gatingJobs: new Map([["ci-checks-rest", ["bun run check"]]]),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set<string>(),
      });
    expect(failure("bun --filter @stll/orphan test; echo done")).toBe(
      "job condition: no gating job executes @stll/orphan test",
    );
    expect(failure("bun --filter @stll/orphan test | cat")).toBe(
      "job condition: no gating job executes @stll/orphan test",
    );
    expect(
      failure("bun --filter @stll/orphan test && echo done"),
    ).toBeUndefined();
  });

  check(
    "only a successful adjacent directory change supplies package context",
    () => {
      for (const command of [
        "echo cd packages/fixture && bun run test",
        "cd packages/fixture || true; bun run test",
        "false && cd packages/fixture; bun run test",
        "cd packages/fixture && cd packages/other && bun run test",
      ]) {
        expect(
          packageTestExecutionFailure({
            gatingJobs: new Map([["checks", [command]]]),
            packageDirectory: "packages/fixture",
            packageName: "@stll/fixture",
            shardedPackages: new Set<string>(),
          }),
        ).toBe("job condition: no gating job executes @stll/fixture test");
      }
      expect(
        packageTestExecutionFailure({
          rootScripts: { check: "bun --filter @stll/fixture test" },
          gatingJobs: new Map([["checks", [": cd && bun run check"]]]),
          packageDirectory: "packages/fixture",
          packageName: "@stll/fixture",
          shardedPackages: new Set<string>(),
        }),
      ).toBeUndefined();
      for (const separator of ["&&", ";", "\n"]) {
        const command = `cd packages/fixture${separator}bun run test`;
        const options = {
          packageDirectory: "packages/fixture",
          packageName: "@stll/fixture",
          shardedPackages: new Set<string>(),
        };
        expect(
          packageTestExecutionFailure({
            ...options,
            gatingJobs: new Map([["checks", [command]]]),
          }),
        ).toBeUndefined();
        const packageFailure = packageTestExecutionFailure({
          ...options,
          rootScripts: { check: command },
          gatingJobs: new Map([["checks", ["bun run check"]]]),
        });
        if (separator === "&&") {
          expect(packageFailure).toBeUndefined();
        } else {
          expect(packageFailure).toBe(
            "job condition: no gating job executes @stll/fixture test",
          );
        }
      }
    },
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
        shardedPackages: new Set<string>(),
      }),
    ).toBe("job condition: no gating job executes @stll/orphan test");
  });

  check.each([
    "bun --filter @stll/orphan test -- one.test.ts",
    "bun run --cwd packages/orphan test -- one.test.ts",
    "cd packages/orphan && bun run test -- one.test.ts",
  ])("combines package collection with forwarded filters: %s", (command) => {
    const options = {
      gatingJobs: new Map([["package-check", [command]]]),
      packageDirectory: "packages/orphan",
      packageName: "@stll/orphan",
      shardedPackages: new Set<string>(),
    };
    expect(
      packageTestExecutionFailure({
        ...options,
        collection: {
          candidate: "packages/orphan/one.test.ts",
          scripts: { test: "bun test" },
        },
      }),
    ).toBeUndefined();
    expect(
      packageTestExecutionFailure({
        ...options,
        collection: {
          candidate: "packages/orphan/two.test.ts",
          scripts: { test: "bun test" },
        },
      }),
    ).toContain("does not collect");
  });

  check.each([
    ["bun test src/one", "two.test.ts", true],
    ["bun test --preload ./setup.ts", "--timeout 100 one", false],
    ["bun run test:unit", "one.test.ts", false],
    ["bun test", "./one.test.ts", false],
    ["bun test", "one", false],
    ["bun test", "--path-ignore-patterns '**/two.test.ts'", false],
  ])(
    "combines Bun body %s with arguments %s",
    (body, forwarded, collectsTwo) => {
      const command = `bun --filter @stll/orphan test -- ${forwarded}`;
      const options = {
        gatingJobs: new Map([["package-check", [command]]]),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set<string>(),
      };
      const scripts = { test: body, "test:unit": "bun test" };
      const failure = packageTestExecutionFailure({
        ...options,
        collection: { candidate: "packages/orphan/src/two.test.ts", scripts },
      });
      if (collectsTwo) {
        expect(failure).toBeUndefined();
      } else {
        expect(failure).toBeDefined();
      }
    },
  );

  check.each([
    `"\${args[@]}"`,
    '"$(( shard + 1 ))"',
    "--shard 1/2",
    "-t focused",
  ])(
    "fails closed and names unresolved forwarded arguments: %s",
    (forwarded) => {
      const command = `bun --filter @stll/orphan test -- ${forwarded}`;
      const failure = packageTestExecutionFailure({
        gatingJobs: new Map([["package-check", [command]]]),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set(),
        collection: {
          candidate: "packages/orphan/two.test.ts",
          scripts: { test: "bun test" },
        },
      });
      expect(failure).toContain("runner arguments: unresolved");
      expect(failure).toContain(command);
    },
  );

  check(
    "resolves the root query-cache check without broadening its forwarded selection",
    () => {
      const topology = {
        workflow: "",
        gatingJobs: new Map([
          ["package-check", ["bun run check:query-cache-types"]],
        ]),
        shardedPackages: new Set<string>(),
      };
      expect(
        firstCollectionFailure({
          file: "packages/scripts/src/query-cache-types.test.ts",
          nonGatingFiles: new Set(),
          topology,
        }),
      ).toBeUndefined();
      expect(
        firstCollectionFailure({
          file: "packages/scripts/src/i18n-usage.test.ts",
          nonGatingFiles: new Set(),
          topology,
        }),
      ).toContain("does not collect");
    },
  );

  check.each(["nightly-test", "api-test-memory", "network-baseline-record"])(
    "separate workflow %s supplies no gating credit",
    (name) => {
      const workflow = Bun.YAML.parse(
        readFileSync(
          new URL(`../.github/workflows/${name}.yml`, import.meta.url),
          "utf-8",
        ),
      );
      expect(gatingWorkflowJobs(workflow).size).toBe(0);
    },
  );

  check("requires the gating job to invoke the exact test script", () => {
    expect(
      packageTestExecutionFailure({
        gatingJobs: new Map([
          ["package-check", ["bun --filter @stll/orphan test:smoke"]],
        ]),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set<string>(),
      }),
    ).toBe("job condition: no gating job executes @stll/orphan test");
  });

  check.each([
    "RUNNER || true",
    "RUNNER||true",
    "RUNNER || :",
    "RUNNER || exit 0",
    "RUNNER; true",
    "RUNNER; exit 0",
    "RUNNER\ntrue",
    "RUNNER\nexit 0",
    "set +e\nRUNNER",
    "set +e; RUNNER; set -e",
  ])("failure-suppressed runners do not gate: %s", (shape) => {
    const packageCommand = shape.replace(
      "RUNNER",
      "bun --filter @stll/orphan test",
    );
    const serviceCommand = "bun run test:postgres";
    expect([
      packageTestExecutionFailure({
        gatingJobs: new Map([["package-check", [packageCommand]]]),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set<string>(),
      }),
      managedServiceRunnerFailure({
        command: serviceCommand,
        gate: "STELLA_RUN_POSTGRES_TESTS",
        gatingJobs: new Map([
          ["service-suites", [shape.replace("RUNNER", () => serviceCommand)]],
        ]),
      }),
    ]).toEqual([
      "job condition: no gating job executes @stll/orphan test",
      "job condition: no gating job executes the STELLA_RUN_POSTGRES_TESTS runner",
    ]);
  });

  check.each([
    "echo RUNNER",
    'echo "RUNNER"',
    "echo 'RUNNER'",
    "printf '%s\\n' RUNNER",
    "echo ignored > RUNNER",
    "echo ignored >& RUNNER",
    "# RUNNER",
    "cat <<'EOF'\nRUNNER\nEOF",
    "cat <<EOF\nRUNNER\nEOF",
    "cat <<-EOF\n\tRUNNER\n\tEOF",
    "echo ';' RUNNER",
    "echo timeout 30s RUNNER",
    'echo bash "$GITHUB_WORKSPACE/.github/actions/setup-playwright/run-in-image.sh" RUNNER',
    'bash "$GITHUB_WORKSPACE/.github/actions/setup-playwright/run-in-image.sh" --prepare RUNNER',
    "bash scripts/other.sh RUNNER",
    "timeout --help RUNNER",
    '"RUNNER',
    "'RUNNER",
  ])("command text does not execute a runner: %s", (shape) => {
    const gatingJobs = (runner: string) =>
      new Map([["checks", [shape.replace("RUNNER", () => runner)]]]);
    expect(
      packageTestExecutionFailure({
        gatingJobs: gatingJobs("bun --filter @stll/orphan test"),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set<string>(),
      }),
    ).toBe("job condition: no gating job executes @stll/orphan test");
    expect(
      rootCommandExecutionFailure({
        command: "bun scripts/test-gate.ts",
        gatingJobs: gatingJobs("bun scripts/test-gate.ts"),
      }),
    ).toBe("job condition: no gating job executes bun scripts/test-gate.ts");
    expect(
      managedServiceRunnerFailure({
        command: "bun run test:postgres",
        gate: "STELLA_RUN_POSTGRES_TESTS",
        gatingJobs: gatingJobs("bun run test:postgres"),
      }),
    ).toBe(
      "job condition: no gating job executes the STELLA_RUN_POSTGRES_TESTS runner",
    );
  });

  check.each([
    "true",
    ": literal",
    "cd packages/fixture",
    "export FIXTURE=literal",
    "FIXTURE=literal",
    "set -e",
    "set -o pipefail",
    "bun test unit",
  ])("credits a runner after a known safe prefix: %s", (prefix) => {
    expect(
      rootCommandExecutionFailure({
        command: "bun scripts/test-gate.ts",
        gatingJobs: new Map([
          ["checks", [`${prefix} && bun scripts/test-gate.ts`]],
        ]),
      }),
    ).toBeUndefined();
  });

  check("does not trust a delegated script that only prints a runner", () => {
    expect(
      packageTestCollectionFailure({
        candidate: "packages/fixture/integration/a.test.ts",
        packageDirectory: "packages/fixture",
        scripts: {
          test: "bun run test:setup && bun test integration",
          "test:setup": "echo bun test",
        },
      }),
    ).toBeDefined();
  });

  check.each([
    "false && RUNNER",
    "false && FIXTURE=literal && RUNNER",
    'X="$VALUE" Y=literal && RUNNER',
    'if [ -n "$X" ]; then exit 0; fi; RUNNER',
    '[ -n "$X" ] && RUNNER',
    "unknown-cmd && RUNNER",
    "false | true && RUNNER",
    "unknown-cmd | true && RUNNER",
    "if unknown-cmd; true; then RUNNER; fi",
    "$COMMAND && RUNNER",
    'cd "$DIRECTORY" && RUNNER',
    'X="$VALUE" && RUNNER',
    "$(unknown-cmd) && RUNNER",
    'case "$SUBJECT" in ready) RUNNER;; esac',
    "true || RUNNER",
    "if false; then RUNNER; fi",
    'if [ "$CONDITION" = yes ]; then RUNNER; fi',
    "if check-condition; then RUNNER; fi",
    "case ready in waiting) RUNNER;; esac",
    "while false; do RUNNER; done",
    "until true; do RUNNER; done",
    "for item in; do RUNNER; done",
    "false\nRUNNER",
    "false; RUNNER",
  ])("does not credit a runner in a skipped shell branch: %s", (shape) => {
    const gatingJobs = (runner: string) =>
      new Map([["checks", [shape.replace("RUNNER", () => runner)]]]);
    expect(
      packageTestExecutionFailure({
        gatingJobs: gatingJobs("bun --filter @stll/orphan test"),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set<string>(),
      }),
    ).toContain("job condition: no gating job executes @stll/orphan test");
    expect(
      rootCommandExecutionFailure({
        command: "bun scripts/test-gate.ts",
        gatingJobs: gatingJobs("bun scripts/test-gate.ts"),
      }),
    ).toContain(
      "job condition: no gating job executes bun scripts/test-gate.ts",
    );
    expect(
      managedServiceRunnerFailure({
        command: "bun run test:postgres",
        gate: "STELLA_RUN_POSTGRES_TESTS",
        gatingJobs: gatingJobs("bun run test:postgres"),
      }),
    ).toContain(
      "job condition: no gating job executes the STELLA_RUN_POSTGRES_TESTS runner",
    );
  });

  check.each([
    "set +e; set -e; RUNNER",
    "echo set +e; RUNNER",
    "FIXTURE_MODE=on RUNNER",
    "timeout --kill-after=5s 30s RUNNER",
    "timeout -s TERM -k 5s 30s RUNNER",
    'bash "$GITHUB_WORKSPACE/.github/actions/setup-playwright/run-in-image.sh" RUNNER',
    "bash .github/actions/setup-playwright/run-in-image.sh --offline RUNNER",
    "if true; then RUNNER; fi",
    "cat <<'EOF'\ndata\nEOF\nRUNNER",
    "RUNNER || exit 1",
    "RUNNER; cleanup || true",
  ])("preserves failure-propagating runners: %s", (shape) => {
    const serviceCommand = "bun run test:postgres";
    expect([
      packageTestExecutionFailure({
        gatingJobs: new Map([
          [
            "package-check",
            [shape.replace("RUNNER", "bun --filter @stll/orphan test")],
          ],
        ]),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set<string>(),
      }),
      managedServiceRunnerFailure({
        command: serviceCommand,
        gate: "STELLA_RUN_POSTGRES_TESTS",
        gatingJobs: new Map([
          ["service-suites", [shape.replace("RUNNER", () => serviceCommand)]],
        ]),
      }),
    ]).toEqual([undefined, undefined]);
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
        shardedPackages: new Set<string>(),
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
        shardedPackages: new Set<string>(),
      }),
    ).toBe("job condition: no gating job executes @stll/orphan test");
  });

  check("an include entry adds back a leg that exclude removed", () => {
    const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    strategy:
      matrix:
        event: [pull_request]
        exclude:
          - event: pull_request
        include:
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
        shardedPackages: new Set<string>(),
      }),
    ).toBeUndefined();
  });

  check(
    "a required root command whose failure is suppressed does not gate",
    () => {
      for (const run of [
        "bun scripts/test-gate.ts || true",
        "bun scripts/test-gate.ts || echo failed",
        "bun scripts/test-gate.ts && echo passed; echo done",
        "bun scripts/test-gate.ts || { echo failed; exit 0; }",
        "set +e; bun scripts/test-gate.ts",
      ]) {
        const workflow = Bun.YAML.parse(`
jobs:
  checks:
    steps:
      - run: ${JSON.stringify(run)}
  ci-result:
    needs: [checks]
`);
        expect(
          rootCommandExecutionFailure({
            command: "bun scripts/test-gate.ts",
            gatingJobs: gatingWorkflowJobs(workflow),
          }),
        ).toBe(
          "job condition: no gating job executes bun scripts/test-gate.ts",
        );
      }
      const gating = Bun.YAML.parse(`
jobs:
  checks:
    steps:
      - run: bun scripts/test-gate.ts
  ci-result:
    needs: [checks]
`);
      expect(
        rootCommandExecutionFailure({
          command: "bun scripts/test-gate.ts",
          gatingJobs: gatingWorkflowJobs(gating),
        }),
      ).toBeUndefined();
    },
  );

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
        shardedPackages: new Set<string>(),
      }),
    ).toBeUndefined();
  });

  check("credits only include legs shared by both literal alternatives", () => {
    const workflow = (os: string, include: string) =>
      Bun.YAML.parse(`
jobs:
  package-check:
    strategy:
      matrix:
        include: >-
          ${include}
    steps:
      - if: matrix.os == '${os}'
        run: bun --filter @stll/orphan test
  ci-result:
    needs: [package-check]
`);
    const choice = `\${{ fromJSON(needs.plan.outputs.depth == 'thin'
          && '[{"os":"macos"}]'
          || '[{"os":"macos"},{"os":"windows"}]') }}`;
    const failure = (os: string, include: string) =>
      packageTestExecutionFailure({
        gatingJobs: gatingWorkflowJobs(workflow(os, include)),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set<string>(),
      });
    expect(failure("macos", choice)).toBeUndefined();
    expect(failure("windows", choice)).toBe(
      "job condition: no gating job executes @stll/orphan test",
    );
    const planned = `\${{ fromJSON(needs.plan.outputs.platforms) }}`;
    expect(failure("macos", planned)).toBe(
      "job condition: no gating job executes @stll/orphan test",
    );
    expect(analyzeGatingWorkflow(workflow("macos", planned)).findings).toEqual([
      "job condition: package-check/step-1 has unresolved context matrix.os",
    ]);
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
        shardedPackages: new Set<string>(),
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
          shardedPackages: new Set<string>(),
        }),
      ).toBe("job condition: no gating job executes @stll/orphan test");
    },
  );

  check("fails closed and names unresolved repository variables", () => {
    for (const value of ["on", "enabled"]) {
      const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    steps:
      - if: vars.SOME_TOGGLE == '${value}'
        run: bun --filter @stll/orphan test
  ci-result:
    needs: [package-check]
`);
      const analysis = analyzeGatingWorkflow(workflow);
      expect(analysis.findings, value).toEqual([
        "job condition: package-check/step-1 has unresolved context vars.SOME_TOGGLE",
      ]);
      expect(
        packageTestExecutionFailure({
          gatingJobs: analysis.jobs,
          packageDirectory: "packages/orphan",
          packageName: "@stll/orphan",
          shardedPackages: new Set<string>(),
        }),
        value,
      ).toBe("job condition: no gating job executes @stll/orphan test");
    }
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
        shardedPackages: new Set<string>(),
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
        shardedPackages: new Set<string>(),
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
        shardedPackages: new Set<string>(),
      }),
    ).toBe("job condition: no gating job executes @stll/orphan test");
  });

  check("a fallback that fails keeps the runner gating", () => {
    for (const run of [
      "bun scripts/test-gate.ts || { echo failed; exit 1; }",
      "bun scripts/test-gate.ts || false",
      "bun scripts/test-gate.ts &&\n  bun scripts/network-baseline-scope.ts validate",
    ]) {
      const workflow = Bun.YAML.parse(`
jobs:
  checks:
    steps:
      - run: ${JSON.stringify(run)}
  ci-result:
    needs: [checks]
`);
      expect(
        rootCommandExecutionFailure({
          command: "bun scripts/test-gate.ts",
          gatingJobs: gatingWorkflowJobs(workflow),
        }),
        run,
      ).toBeUndefined();
    }
  });

  check("ignores package commands that may continue on error", () => {
    const placements: readonly (readonly [string, string])[] = [
      [`continue-on-error: \${{ vars.ALLOW_TEST_FAILURE }}`, ""],
      ["", `continue-on-error: \${{ vars.ALLOW_TEST_FAILURE }}`],
    ];
    for (const [jobOption, stepOption] of placements) {
      const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    ${jobOption}
    steps:
      - run: bun --filter @stll/orphan test
        ${stepOption}
  ci-result:
    needs: [package-check]
`);
      expect(
        packageTestExecutionFailure({
          gatingJobs: gatingWorkflowJobs(workflow),
          packageDirectory: "packages/orphan",
          packageName: "@stll/orphan",
          shardedPackages: new Set<string>(),
        }),
      ).toBe("job condition: no gating job executes @stll/orphan test");
    }
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
        shardedPackages: new Set<string>(),
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
        shardedPackages: new Set<string>(),
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

context("root test runner coverage", () => {
  const files = [
    "scripts/orphan.test.ts",
    ".oxlint-plugins/__tests__/orphan.test.ts",
  ];
  const runner =
    "bun scripts/run-unlisted-script-tests.ts\nbun scripts/run-custom-lint-tests.ts";
  const cases = [
    { name: "disabled", condition: "if: false" },
    { name: "push-only", condition: "if: github.event_name == 'push'" },
    { name: "continue-on-error", condition: "continue-on-error: true" },
  ];
  for (const { name, condition } of cases) {
    for (const file of files) {
      check(`rejects ${file} collected only by a ${name} step`, () => {
        const workflow = `jobs:
  root-tests:
    steps:
      - ${condition}
        run: |
          ${runner.replaceAll("\n", "\n          ")}
  ci-result:
    needs: [root-tests]
`;
        const topology = {
          gatingJobs: gatingWorkflowJobs(Bun.YAML.parse(workflow)),
          shardedPackages: new Set<string>(),
          workflow,
        };
        expect(
          firstCollectionFailure({ file, nonGatingFiles: new Set(), topology }),
        ).toBe(`job condition: no gating job collects ${file}`);
      });
    }
  }

  check("counts the actual root collectors and their file boundaries", () => {
    const workflow = `jobs:
  root-tests:
    steps:
      - run: |
          ${runner.replaceAll("\n", "\n          ")}
      - run: bun test scripts/named.test.ts
  ci-result:
    needs: [root-tests]
`;
    const topology = {
      gatingJobs: gatingWorkflowJobs(Bun.YAML.parse(workflow)),
      shardedPackages: new Set<string>(),
      workflow,
    };
    for (const file of [
      ...files,
      "scripts/named.test.ts",
      ".oxlint-plugins/__tests__/nested/orphan.test.ts",
    ]) {
      expect(
        firstCollectionFailure({ file, nonGatingFiles: new Set(), topology }),
      ).toBeUndefined();
    }
    const file = ".oxlint-plugins/other/orphan.test.ts";
    expect(
      firstCollectionFailure({ file, nonGatingFiles: new Set(), topology }),
    ).toBe(`job condition: no gating job collects ${file}`);
  });

  check("custom lint runner selections bound collection", () => {
    const selected = ".oxlint-plugins/__tests__/selected.test.ts";
    const other = ".oxlint-plugins/__tests__/other.test.ts";
    for (const run of [
      `bun scripts/run-custom-lint-tests.ts ${selected}`,
      `echo bun scripts/run-custom-lint-tests.ts ${selected}`,
    ]) {
      const workflow = `jobs:\n  checks:\n    steps:\n      - run: ${run}\n  ci-result:\n    needs: [checks]\n`;
      const topology = {
        gatingJobs: gatingWorkflowJobs(Bun.YAML.parse(workflow)),
        shardedPackages: new Set<string>(),
        workflow,
      };
      expect(
        firstCollectionFailure({
          file: selected,
          nonGatingFiles: new Set(),
          topology,
        }),
      ).toBe(
        run.startsWith("echo")
          ? `job condition: no gating job collects ${selected}`
          : undefined,
      );
      expect(
        firstCollectionFailure({
          file: other,
          nonGatingFiles: new Set(),
          topology,
        }),
      ).toBe(`job condition: no gating job collects ${other}`);
    }
  });

  check(
    "a named non-gating script cannot fall back to the unlisted runner",
    () => {
      const workflow = `jobs:
  root-tests:
    steps:
      - if: false
        run: bun test scripts/named.test.ts
      - run: bun scripts/run-unlisted-script-tests.ts
  ci-result:
    needs: [root-tests]
`;
      expect(
        firstCollectionFailure({
          file: "scripts/named.test.ts",
          nonGatingFiles: new Set(),
          topology: {
            gatingJobs: gatingWorkflowJobs(Bun.YAML.parse(workflow)),
            shardedPackages: new Set<string>(),
            workflow,
          },
        }),
      ).toBe("job condition: no gating job collects scripts/named.test.ts");
    },
  );
});

context("root runner command shapes", () => {
  const cases = [
    {
      file: "scripts/network-baseline-coverage.test.ts",
      command:
        "timeout 30s bash -c 'bun test scripts/network-baseline-coverage.test.ts && bun scripts/network-baseline-scope.ts validate'",
    },
    {
      file: "scripts/check-api-cli-contract.test.ts",
      command: String.raw`bun test --preload ./apps/api/src/tests/setup-env.ts \
  scripts/check-api-cli-contract.test.ts`,
    },
    {
      file: "scripts/transfer-read-guard.test.ts",
      command:
        "bun run --cwd packages/scripts test ../../scripts/transfer-read-guard.test.ts",
    },
  ];
  for (const { file, command } of cases) {
    check(`collects ${file} only when its actual command gates`, () => {
      for (const condition of ["", "if: false\n        "]) {
        const workflow = `jobs:
  root-tests:
    steps:
      - ${condition}run: |
          ${command.replaceAll("\n", "\n          ")}
  ci-result:
    needs: [root-tests]
`;
        const failure = firstCollectionFailure({
          file,
          nonGatingFiles: new Set(),
          topology: {
            gatingJobs: gatingWorkflowJobs(Bun.YAML.parse(workflow)),
            shardedPackages: new Set<string>(),
            workflow,
          },
        });
        expect(failure).toBe(
          condition === ""
            ? undefined
            : `job condition: no gating job collects ${file}`,
        );
      }
    });
  }
});

context("suppressed collection", () => {
  const shapes = [
    "RUNNER || true",
    "RUNNER || :",
    "RUNNER || exit 0",
    "RUNNER; true",
    "RUNNER; exit 0",
    "set +e; RUNNER",
  ];
  for (const shape of shapes) {
    for (const runner of [
      "bun scripts/run-unlisted-script-tests.ts",
      "bun test scripts/named.test.ts",
      "timeout 30s bash -c 'bun test scripts/named.test.ts'",
    ]) {
      check(
        `rejects root collector ${shape.replace("RUNNER", () => runner)}`,
        () => {
          const command = shape.replace("RUNNER", () => runner);
          const workflow = `jobs:
  root-tests:
    steps:
      - run: ${command}
  ci-result:
    needs: [root-tests]
`;
          expect(
            firstCollectionFailure({
              file: "scripts/named.test.ts",
              nonGatingFiles: new Set(),
              topology: {
                gatingJobs: new Map([["root-tests", [command]]]),
                shardedPackages: new Set<string>(),
                workflow,
              },
            }),
          ).toBe("job condition: no gating job collects scripts/named.test.ts");
        },
      );
    }
    check(`rejects a package script body ${shape}`, () => {
      expect(
        packageTestExecutionFailure({
          gatingJobs: new Map([
            ["package-tests", ["bun --filter @stll/orphan test"]],
          ]),
          packageDirectory: "packages/orphan",
          packageName: "@stll/orphan",
          shardedPackages: new Set<string>(),
        }),
      ).toBeUndefined();
      for (const scripts of [
        { test: shape.replace("RUNNER", "bun test") },
        {
          test: "bun run test:unit",
          "test:unit": shape.replace("RUNNER", "bun test"),
        },
        {
          test: shape.replace("RUNNER", "bun run test:unit"),
          "test:unit": "bun test",
        },
      ]) {
        expect(
          packageTestCollectionFailure({
            candidate: "packages/orphan/src/orphan.test.ts",
            packageDirectory: "packages/orphan",
            scripts,
          }),
        ).toBe(
          "runner command: test script does not invoke a gating test runner",
        );
      }
    });
  }
});

context("Playwright failure propagation", () => {
  check.each([
    {
      layer: "workflow",
      invocation: "bun --filter @stll/desktop test:browser || true",
      body: "playwright test --config playwright.config.ts",
    },
    {
      layer: "package script",
      invocation: "bun --filter @stll/desktop test:browser",
      body: "playwright test --config playwright.config.ts || true",
    },
  ])("rejects suppression in the $layer", ({ invocation, body }) => {
    expect(
      gatingPlaywrightCollection({
        file: "apps/desktop/tests/browser/theme-prepaint.playwright.spec.ts",
        packageFile: "apps/desktop/package.json",
        scripts: { "test:browser": body },
        topology: {
          gatingJobs: new Map([["browser-tests", [invocation]]]),
          shardedPackages: new Set<string>(),
          workflow: invocation,
        },
      }),
    ).toEqual({ type: "not-collected" });
  });
});

context("Playwright configuration filters", () => {
  const collects = (
    filter: string,
    name = "theme-prepaint.playwright.spec.ts",
  ) =>
    gatingPlaywrightCollection({
      file: `apps/desktop/tests/browser/${name}`,
      packageFile: "apps/desktop/package.json",
      scripts: { "test:browser": "playwright test" },
      topology: {
        gatingJobs: new Map([
          ["browser-tests", ["bun --filter @stll/desktop test:browser"]],
        ]),
        shardedPackages: new Set<string>(),
        workflow: "",
      },
      readConfig: () =>
        `export default defineConfig({ testDir: "./tests/browser", ${filter} });`,
    });
  check("an array testIgnore excludes a file", () => {
    expect(
      collects('testIgnore: ["**/theme-prepaint.playwright.spec.ts"]'),
    ).toEqual({ type: "not-collected" });
  });
  check("an array testMatch includes only matching files", () => {
    const filter = 'testMatch: ["**/theme-prepaint.playwright.spec.ts"]';
    expect(collects(filter)).toEqual({ type: "collected" });
    expect(collects(filter, "other.playwright.spec.ts")).toEqual({
      type: "not-collected",
    });
  });
  check(
    "literal RegExp patterns used by repository projects are resolved",
    () => {
      expect(
        collects(
          String.raw`testIgnore: /landing-.*\.spec\.ts$/u`,
          "landing-home.spec.ts",
        ),
      ).toEqual({ type: "not-collected" });
      expect(
        collects(
          String.raw`testMatch: /landing-.*\.spec\.ts$/u`,
          "landing-home.spec.ts",
        ),
      ).toEqual({ type: "collected" });
    },
  );
  check(
    "project filters are inherited and coverage is the union of projects",
    () => {
      expect(
        collects(
          'testMatch: ["**/theme-prepaint.playwright.spec.ts"], projects: [{ testIgnore: ["**/*.spec.ts"] }]',
        ),
      ).toEqual({ type: "not-collected" });
      expect(
        collects(
          'projects: [{ testIgnore: ["**/*.spec.ts"] }, { testMatch: ["**/theme-prepaint.playwright.spec.ts"] }]',
        ),
      ).toEqual({ type: "collected" });
    },
  );
  check.each([
    'testIgnore: ["**/*.spec.ts", unknownPattern]',
    'testIgnore: () => "**/*.spec.ts"',
    "testIgnore: false",
  ])("unsupported filter fails closed: %s", (filter) => {
    expect(collects(filter)).toEqual({
      type: "unresolved",
      finding:
        "runner config: apps/desktop/playwright.config.ts has unresolved testIgnore",
    });
  });
  check.each(["grep: /smoke/", "grepInvert: /slow/"])(
    "a title filter in the config fails closed: %s",
    (filter) => {
      expect(collects(filter)).toEqual({
        type: "unresolved",
        finding: `runner config: apps/desktop/playwright.config.ts has unresolved ${filter.slice(0, filter.indexOf(":"))}`,
      });
    },
  );
  check("an unresolved RegExp fails closed", () => {
    expect(collects('testMatch: new RegExp(".*")')).toEqual({
      type: "unresolved",
      finding:
        "runner config: apps/desktop/playwright.config.ts has unresolved testMatch",
    });
  });
});

context("Playwright CLI selection", () => {
  check.each([
    {
      body: "playwright test one.spec.ts",
      invocation: "bun --filter @stll/desktop test:browser",
    },
    {
      body: "playwright test",
      invocation: "bun --filter @stll/desktop test:browser -- one.spec.ts",
    },
    {
      body: "playwright test --project selected",
      invocation: "bun --filter @stll/desktop test:browser",
    },
    {
      body: "playwright test",
      invocation:
        "bun --filter @stll/desktop test:browser -- --project=selected",
    },
  ])(
    "credits only the selected spec: $body / $invocation",
    ({ body, invocation }) => {
      const collects = (name: string) =>
        gatingPlaywrightCollection({
          file: `apps/desktop/tests/browser/${name}.spec.ts`,
          packageFile: "apps/desktop/package.json",
          scripts: { "test:browser": body },
          topology: {
            gatingJobs: new Map([["browser-tests", [invocation]]]),
            shardedPackages: new Set<string>(),
            workflow: invocation,
          },
          readConfig:
            () => `export default defineConfig({ testDir: "./tests/browser", projects: [
        { name: "selected", testMatch: ["**/one.spec.ts"] },
        { name: "other", testMatch: ["**/two.spec.ts"] },
      ] });`,
        });
      expect(collects("one")).toEqual({ type: "collected" });
      expect(collects("two")).toEqual({ type: "not-collected" });
    },
  );
});

context("Playwright selector contracts", () => {
  type SelectionOptions = {
    arguments_: string;
    name?: string;
  };
  const collect = ({ arguments_, name = "one" }: SelectionOptions) => {
    const invocation = `bun --filter @stll/desktop test:browser -- ${arguments_}`;
    return gatingPlaywrightCollection({
      file: `apps/desktop/tests/browser/${name}.spec.ts`,
      packageFile: "apps/desktop/package.json",
      scripts: { "test:browser": "playwright test" },
      topology: {
        gatingJobs: new Map([["browser-tests", [invocation]]]),
        shardedPackages: new Set<string>(),
        workflow: invocation,
      },
      readConfig: () => `export default defineConfig({
        testDir: "./tests/browser",
        projects: [
          { name: "chromium-desktop", testMatch: "**/one.spec.ts" },
          { name: "chromium-mobile", testMatch: "**/two.spec.ts" },
          { name: "firefox", testMatch: "**/three.spec.ts" },
        ],
      });`,
    });
  };

  check.each(["one", "one[.]spec[.]ts$", "one|two"])(
    "matches positional file filters as regular expressions: %s",
    (arguments_) => {
      expect(collect({ arguments_ })).toEqual({ type: "collected" });
      expect(collect({ arguments_, name: "three" })).toEqual({
        type: "not-collected",
      });
    },
  );

  check.each([
    "--project 'chromium-*'",
    "--project chromium-desktop --project chromium-mobile",
    "--project chromium-desktop chromium-mobile",
  ])(
    "unions selected projects without crediting other projects: %s",
    (arguments_) => {
      expect(collect({ arguments_ })).toEqual({ type: "collected" });
      expect(collect({ arguments_, name: "two" })).toEqual({
        type: "collected",
      });
      expect(collect({ arguments_, name: "three" })).toEqual({
        type: "not-collected",
      });
    },
  );

  check.each([
    "--grep=focused",
    "--last-failed",
    "--unknown-selector",
    "--shard=0/2",
  ])(
    "names unsupported selection arguments in a command finding: %s",
    (arguments_) => {
      const invocation = `bun --filter @stll/desktop test:browser -- ${arguments_}`;
      expect(collect({ arguments_ })).toEqual({
        type: "unresolved",
        finding: `runner command: playwright test (workflow: ${invocation}) has unresolved Playwright selection ${arguments_}`,
      });
    },
  );
});

context("Playwright shard execution coverage", () => {
  const collect = (steps: string) => {
    const workflow = `jobs:
  browser-tests:
    steps:
${steps}
  ci-result:
    needs: [browser-tests]
`;
    const analysis = analyzeGatingWorkflow(Bun.YAML.parse(workflow));
    return gatingPlaywrightCollection({
      file: "apps/desktop/tests/browser/one.spec.ts",
      packageFile: "apps/desktop/package.json",
      scripts: { "test:browser": "playwright test" },
      topology: {
        gatingJobs: analysis.jobs,
        shardedPackages: new Set<string>(),
        workflow,
      },
      readConfig: () =>
        'export default defineConfig({ testDir: "./tests/browser" });',
    });
  };
  const first = "bun --filter @stll/desktop test:browser -- --shard=1/2";

  check("an incomplete shard union remains a named command finding", () => {
    expect(collect(`      - run: ${first}`)).toEqual({
      type: "unresolved",
      finding: `runner command: playwright test (workflow: ${first}) has unresolved Playwright selection --shard=1/2`,
    });
  });
});
