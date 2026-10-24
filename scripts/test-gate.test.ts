import { describe as context, expect, test as check } from "bun:test";
import { readFileSync } from "node:fs";

import { sha256Hex } from "../packages/sha256/src/bun";
import { allE2eShards } from "./e2e-spec-shards-core";
import {
  analyzeGatingWorkflow,
  firstCollectionFailure,
  gatingPlaywrightCollection,
  gatingWorkflowJobs,
  managedServiceRunnerFailure,
  packageTestCollectionFailure,
  packageTestExecutionFailure,
  parseDisabledLedger,
  parseScenarioLedger,
  parseTestRegistrations,
  platformConditionalFailure,
  repositoryTestExecutionTopology,
  resultAggregationFailures,
  rootCommandExecutionFailure,
  scenarioBlockerFailure,
  scenarioLedgerGrowth,
  validateGatingEventFacts,
  validateTrustedOutputProducers,
} from "./test-gate";
import type { ScenarioBlocker, TestScenario } from "./test-gate";
import { TRUSTED_OUTPUT_PRODUCERS } from "./test-gate-output-producers";
import type { TrustedOutputProducer } from "./test-gate-output-producers";

const bashJobs = (entries: readonly (readonly [string, readonly string[]])[]) =>
  new Map(
    entries.map(([name, commands]) => [
      name,
      commands.map((command) => ({
        command,
        environment: {},
        propagation: { errexit: true, pipefail: true },
      })),
    ]),
  );

context("test registration census", () => {
  check.each([
    "(EXPRESSION)",
    "(EXPRESSION as typeof test)",
    "(EXPRESSION satisfies typeof test)",
    "EXPRESSION!",
    "(<typeof test>EXPRESSION)",
  ])("transparent wrappers preserve registration findings: %s", (shape) => {
    for (const [member, type] of [
      ["only", "only"],
      ["skip", "disabled"],
    ] as const) {
      const expression = shape.replace("EXPRESSION", () => `test.${member}`);
      for (const source of [
        `${expression}("wrapped", () => {});`,
        `const selected = ${expression}; selected("wrapped", () => {});`,
        `${shape.replace("EXPRESSION", "test")}.${member}("wrapped", () => {});`,
      ]) {
        expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
          { identity: "fixture.test.ts::wrapped", type },
        ]);
      }
    }
  });

  check(
    "transparent wrappers preserve conditional aliases, titles and callbacks",
    () => {
      expect(
        parseTestRegistrations(
          "fixture.test.ts",
          `
      const selected = (enabled ? test : test.only) satisfies typeof test;
      selected(("wrapped" as const), () => {});
      test("environment return", (() => { if (!process.env.CI) return; })!);
    `,
        ),
      ).toEqual([
        { identity: "fixture.test.ts::environment return", type: "disabled" },
        { identity: "fixture.test.ts::wrapped", type: "disabled" },
        { identity: "fixture.test.ts::wrapped", type: "only" },
      ]);
    },
  );

  check("wrapped conditional helper calls are inventoried once", () => {
    expect(
      parseTestRegistrations(
        "fixture.test.ts",
        '(test.skipIf(process.env.CI) as typeof test)("wrapped", () => {});',
      ),
    ).toEqual([{ identity: "fixture.test.ts::wrapped", type: "disabled" }]);
  });

  check("mutable registration aliases cannot grant registration credit", () => {
    for (const source of [
      'let selected = test; selected = test.only; selected("focused", () => {});',
      'var selected = test; selected("focused", () => {});',
      'const selected = test; selected = test.only; selected("focused", () => {});',
      "let selected = test;",
      'let selected; selected = test.only; selected("focused", () => {});',
    ]) {
      const findings = parseTestRegistrations("fixture.test.ts", source);
      expect(
        findings.some(
          (finding) =>
            finding.type === "unresolved" &&
            /(?:mutable|assigned) registration alias selected/u.test(
              finding.reason,
            ),
        ),
      ).toBe(true);
    }
    expect(
      parseTestRegistrations(
        "fixture.test.ts",
        'const t = test; t("regular", () => {});',
      ),
    ).toEqual([]);
  });

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

  check.each(["process.env", "Bun.env", "import.meta.env"])(
    "environment aliases of %s cannot hide callback early returns",
    (environment) => {
      const source = `
      const enabled = ${environment}.RUN_TESTS === "true";
      const inherited = enabled;
      let mutable = ${environment}.RUN_TESTS === "true";
      test("reviewer callback", () => {
        if (!enabled) return;
      });
      test("two-hop alias", () => {
        if (!inherited) return;
      });
      test("mutable alias", () => {
        if (!mutable) return;
      });
    `;
      expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
        { identity: "fixture.test.ts::mutable alias", type: "disabled" },
        { identity: "fixture.test.ts::reviewer callback", type: "disabled" },
        { identity: "fixture.test.ts::two-hop alias", type: "disabled" },
      ]);
    },
  );

  check.each([
    { body: "if (process.env.GITHUB_ACTIONS) {} else return;", disabled: true },
    { body: "if (enabled) {} else if (true) return;", disabled: true },
    { body: "if (true) {} else if (enabled) {} else return;", disabled: true },
    { body: "!enabled && ctx.skip();", disabled: true },
    { body: "enabled || test['skip']();", disabled: true },
    { body: "enabled ? work() : ctx.skip();", disabled: true },
    {
      body: "switch (process.env.GITHUB_ACTIONS) { case 'yes': break; default: return; }",
      disabled: true,
    },
    {
      body: "for (const value of values) { if (!enabled) continue; work(value); }",
      disabled: true,
    },
    {
      body: "for (const value of values) { if (!enabled) break; work(value); }",
      disabled: true,
    },
    { body: "while (enabled) { ctx.skip(); }", disabled: true },
    { body: "if (enabled) throw new Error('failed');", disabled: false },
    {
      body: "if (enabled) { const helper = () => { return; }; work(helper); }",
      disabled: false,
    },
    {
      body: "switch (process.env.GITHUB_ACTIONS) { case 'yes': work(); break; default: work(); }",
      disabled: false,
    },
    { body: "enabled && work();", disabled: false },
  ])("environment-controlled callback exit: $body", ({ body, disabled }) => {
    const source = `const enabled = process.env.GITHUB_ACTIONS === 'yes';
      test('controlled', (ctx) => { ${body} expect(actual).toBe(expected); });`;
    const findings = parseTestRegistrations("fixture.test.ts", source);
    if (disabled) {
      expect(findings).toContainEqual({
        identity: "fixture.test.ts::controlled",
        type: "disabled",
      });
    } else {
      expect(findings).toEqual([]);
    }
  });

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

  check("finds focus through literal element access", () => {
    const source = `
      import { it } from "bun:test";
      import * as bt from "bun:test";
      test["only"]("element test", () => {});
      it[\`only\`]("element alias", () => {});
      describe["only"]("element suite", () => {});
      bt.test["only"]("namespace test", () => {});
      bt["test"][\`only\`]("namespace element", () => {});
    `;
    expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
      { identity: "fixture.test.ts::element alias", type: "only" },
      { identity: "fixture.test.ts::element suite", type: "only" },
      { identity: "fixture.test.ts::element test", type: "only" },
      { identity: "fixture.test.ts::namespace element", type: "only" },
      { identity: "fixture.test.ts::namespace test", type: "only" },
    ]);
  });

  check(
    "reports dynamic registration keys without flagging ordinary objects",
    () => {
      const source = `
      const key = getKey();
      const title = getTitle();
      test[key]("literal title", () => {});
      test[key](title, () => {});
      const focused = test[key];
      focused("aliased literal title", () => {});
      object[key]("ordinary object", () => {});
      const other = { test: (_title: string, _callback: () => void) => {} };
      other[key]("ordinary method", () => {});
    `;
      expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
        {
          identity: "fixture.test.ts::<dynamic title at 5:7>",
          type: "unresolved",
          reason: "computed registration key is not literal",
        },
        {
          identity: "fixture.test.ts::aliased literal title",
          type: "unresolved",
          reason: "computed registration key is not literal",
        },
        {
          identity: "fixture.test.ts::literal title",
          type: "unresolved",
          reason: "computed registration key is not literal",
        },
      ]);
    },
  );

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

  check.each([
    'const process = { env: { STELLA_RUN_POSTGRES_TESTS: "false" } }; REGISTRATION',
    '{ const process = { env: { STELLA_RUN_POSTGRES_TESTS: "false" } }; REGISTRATION }',
    "function register(process) { REGISTRATION }",
    'import process from "./other-process"; REGISTRATION',
    'import * as process from "./other-process"; REGISTRATION',
    'import { process } from "./other-process"; REGISTRATION',
    "function register() { REGISTRATION; if (true) { var process = other; } }",
    "try {} catch (process) { REGISTRATION }",
    "for (const process of processes) { REGISTRATION }",
    "const register = function process() { REGISTRATION };",
    "class Example { static { REGISTRATION; var process = other; } }",
  ])("shadowed process cannot earn managed execution credit: %s", (layout) => {
    const source = `import { test } from "bun:test"; ${layout.replace(
      "REGISTRATION",
      'test.skipIf(process.env.STELLA_RUN_POSTGRES_TESTS !== "true")("shadowed", () => {});',
    )}`;
    expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
      { identity: "fixture.test.ts::shadowed", type: "disabled" },
    ]);
  });

  check.each([
    "const Boolean = () => false; REGISTRATION",
    "{ const Boolean = () => false; REGISTRATION }",
    "function register(Boolean) { REGISTRATION }",
    'import { Boolean } from "./other-boolean"; REGISTRATION',
    "function Boolean() { return false; } REGISTRATION",
  ])("shadowed Boolean cannot earn managed execution credit: %s", (layout) => {
    const source = `import { test } from "bun:test"; ${layout.replace(
      "REGISTRATION",
      'test.skipIf(!Boolean(process.env.STELLA_RUN_POSTGRES_TESTS === "true"))("shadowed", () => {});',
    )}`;
    expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
      { identity: "fixture.test.ts::shadowed", type: "disabled" },
    ]);
  });

  check("shadowed undefined cannot substitute for a runtime literal", () => {
    const source = `import { test } from "bun:test";
      { const undefined = "true";
        test.skipIf(process.env.STELLA_RUN_POSTGRES_TESTS === undefined)("shadowed", () => {});
      }`;
    expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
      { identity: "fixture.test.ts::shadowed", type: "disabled" },
    ]);
  });

  check.each([
    "Boolean = () => false;",
    "({ Boolean } = other);",
    "[Boolean] = other;",
    "Boolean++;",
    "Boolean ||= other;",
    "for (Boolean of values) {}",
    'process = { env: { STELLA_RUN_POSTGRES_TESTS: "false" } };',
    "globalThis.Boolean = () => false;",
    "globalThis[key] = other;",
    'globalThis["process"] = { env: { STELLA_RUN_POSTGRES_TESTS: "false" } };',
    'process.env.STELLA_RUN_POSTGRES_TESTS = "false";',
    'process.env["STELLA_RUN_POSTGRES_TESTS"] = "false";',
    'globalThis.process.env.STELLA_RUN_POSTGRES_TESTS = "false";',
    "delete process.env.STELLA_RUN_POSTGRES_TESTS;",
    "process.env = other;",
    'process.env[key] = "false";',
  ])(
    "reassigned runtime owners cannot earn managed execution credit: %s",
    (assignment) => {
      const source = `import { test } from "bun:test";
      ${assignment}
      test.skipIf(!Boolean(process.env.STELLA_RUN_POSTGRES_TESTS === "true"))("reassigned", () => {});`;
      expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
        { identity: "fixture.test.ts::reassigned", type: "disabled" },
      ]);
    },
  );

  check.each([
    "function unrelated(process, Boolean) {} REGISTRATION",
    "{ const process = other; const Boolean = other; } REGISTRATION",
    'const enabled = process.env.STELLA_RUN_POSTGRES_TESTS === "true"; { const process = other; REGISTRATION_ALIAS }',
    'function unrelated() { const enabled = false; } const enabled = process.env.STELLA_RUN_POSTGRES_TESTS === "true"; REGISTRATION_ALIAS',
    "function unrelated(process, Boolean) { process = other; Boolean = other; } REGISTRATION",
    'function unrelated(globalThis) { globalThis.Boolean = other; globalThis.process.env.STELLA_RUN_POSTGRES_TESTS = "false"; } REGISTRATION',
    'process.env.STELLA_LOCAL_DEV = "false"; REGISTRATION',
    "class Example { static { var process = other; var Boolean = other; } } REGISTRATION",
    "namespace Unrelated { var process = other; var Boolean = other; } REGISTRATION",
  ])("service condition bindings retain their lexical owner: %s", (layout) => {
    const source = `import { test } from "bun:test"; ${layout
      .replace(
        "REGISTRATION_ALIAS",
        'test.skipIf(!enabled)("managed", () => {});',
      )
      .replace(
        "REGISTRATION",
        'test.skipIf(!Boolean(process.env.STELLA_RUN_POSTGRES_TESTS === "true"))("managed", () => {});',
      )}`;
    expect(parseTestRegistrations("fixture.test.ts", source)).toEqual([
      {
        identity: "fixture.test.ts::managed",
        managedServiceGate: "STELLA_RUN_POSTGRES_TESTS",
        type: "disabled",
      },
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
    ['test["skipIf"](!runPostgres)("registration", () => {});', true],
    [
      '(test["skipIf"] as typeof test.skipIf)((!runPostgres as boolean))!("registration", () => {});',
      true,
    ],
    [
      'if (runPostgres) (test["skipIf"] as typeof test.skipIf)(runPostgres)("registration", () => {});',
      false,
    ],
    ['if (runPostgres) (test.skip)!("registration", () => {});', false],
    ['test[`skipIf`](!runPostgres)("registration", () => {});', true],
    [
      'if (runPostgres) test["skipIf"](runPostgres)("registration", () => {});',
      false,
    ],
    [
      'if (runPostgres) test[`skipIf`](runPostgres)("registration", () => {});',
      false,
    ],
    [
      'if (runPostgres) test["todoIf"](runPostgres)("registration", () => {});',
      false,
    ],
    [
      'if (runPostgres) test["if"](!runPostgres)("registration", () => {});',
      false,
    ],
    ['if (runPostgres) test["skip"]("registration", () => {});', false],
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
          scenarios: new Map(),
        }),
      ).toBe("package task: no owning package.json");
      expect(
        firstCollectionFailure({
          file: "apps/web/e2e/staging/staging-smoke.spec.ts",
          scenarios: new Map(),
        }),
      ).toBe("runner glob: web wrapper does not collect the file");
      expect(
        firstCollectionFailure({
          file: "apps/web/e2e/staging/staging-smoke.spec.ts",
          scenarios: new Map([
            [
              "apps/web/e2e/staging/staging-smoke.spec.ts",
              {
                type: "non-gating",
                file: "apps/web/e2e/staging/staging-smoke.spec.ts",
                owningWorkflow: ".github/workflows/staging-smoke.yml",
                reason: "deployed-environment scenario",
              },
            ],
          ]),
        }),
      ).toBeUndefined();
      expect(
        firstCollectionFailure({
          file: "apps/desktop/tests/browser/theme-prepaint.playwright.spec.ts",
          scenarios: new Map(),
        }),
      ).toBe("runner glob: test command excludes the file");
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
        ).toContain(
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
          gatingJobs: bashJobs([
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
        gatingJobs: bashJobs([["ci-checks-rest", ["bun run check"]]]),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set<string>(),
      });
    expect(failure("bun --filter @stll/orphan test; echo done")).toContain(
      "job condition: no gating job executes @stll/orphan test",
    );
    expect(failure("bun --filter @stll/orphan test | cat")).toContain(
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
            gatingJobs: bashJobs([["checks", [command]]]),
            packageDirectory: "packages/fixture",
            packageName: "@stll/fixture",
            shardedPackages: new Set<string>(),
          }),
        ).toContain("job condition: no gating job executes @stll/fixture test");
      }
      expect(
        packageTestExecutionFailure({
          rootScripts: { check: "bun --filter @stll/fixture test" },
          gatingJobs: bashJobs([["checks", [": cd && bun run check"]]]),
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
            gatingJobs: bashJobs([["checks", [command]]]),
          }),
        ).toBeUndefined();
        const packageFailure = packageTestExecutionFailure({
          ...options,
          rootScripts: { check: command },
          gatingJobs: bashJobs([["checks", ["bun run check"]]]),
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
        gatingJobs: bashJobs([
          ["ci-checks-rest", ["bun scripts/test-gate.ts"]],
        ]),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set<string>(),
      }),
    ).toContain("job condition: no gating job executes @stll/orphan test");
  });

  check.each([
    "bun --filter @stll/orphan test -- one.test.ts",
    "bun run --cwd packages/orphan test -- one.test.ts",
    "cd packages/orphan && bun run test -- one.test.ts",
  ])("combines package collection with forwarded filters: %s", (command) => {
    const options = {
      gatingJobs: bashJobs([["package-check", [command]]]),
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
        gatingJobs: bashJobs([["package-check", [command]]]),
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
        gatingJobs: bashJobs([["package-check", [command]]]),
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

  check.each([
    ["--filter=@stll/one", true, false],
    ["--filter @stll/two", false, true],
    ["--filter=!@stll/one", false, true],
    ["--filter=./packages/one", true, false],
    ["--filter=@stll/*", true, true],
    ["--filter=@stll/* --filter=!@stll/two", true, false],
    ["--dry=json", false, false],
    ["--unknown-selector", false, false],
  ])("sharded tests honor actual selection %s", (selection, one, two) => {
    const failure = (name: string) =>
      packageTestExecutionFailure({
        rootScripts: { test: "turbo run test" },
        gatingJobs: bashJobs([
          [
            "ci-tests",
            [
              "bun scripts/test-scope.ts",
              "bun scripts/test-shards.ts --filters rest",
              `bun run test -- --concurrency=2 ${selection}`,
            ],
          ],
        ]),
        packageName: `@stll/${name}`,
        packageDirectory: `packages/${name}`,
        shardedPackages: new Set(["@stll/one", "@stll/two"]),
      });
    expect(failure("one") === undefined).toBe(one);
    expect(failure("two") === undefined).toBe(two);
  });

  check("sharded forwarded paths must collect the requested file", () => {
    const options = {
      rootScripts: { test: "turbo run test" },
      gatingJobs: bashJobs([
        [
          "ci-tests",
          [
            "bun run test -- --concurrency=2 --filter=@stll/one -- src/one.test.ts",
          ],
        ],
      ]),
      packageName: "@stll/one",
      packageDirectory: "packages/one",
      shardedPackages: new Set(["@stll/one", "@stll/two"]),
    };
    expect(
      packageTestExecutionFailure({
        ...options,
        collection: {
          candidate: "packages/one/src/one.test.ts",
          scripts: { test: "bun test" },
        },
      }),
    ).toBeUndefined();
    expect(
      packageTestExecutionFailure({
        ...options,
        collection: {
          candidate: "packages/one/src/two.test.ts",
          scripts: { test: "bun test" },
        },
      }),
    ).toContain("does not collect");
  });

  check("the web shard runtime selection cannot credit the API package", () => {
    const workflow = Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/ci.yml", import.meta.url),
        "utf-8",
      ),
    );
    const webRuns = (
      analyzeGatingWorkflow(workflow).jobs.get("ci-tests") ?? []
    ).filter(({ environment }) => environment["SHARD"] === "web");
    expect(webRuns.length).toBeGreaterThan(0);
    const failure = (name: string) =>
      packageTestExecutionFailure({
        rootScripts: { test: "turbo run test" },
        gatingJobs: new Map([["ci-tests", webRuns]]),
        packageName: `@stll/${name}`,
        packageDirectory: `apps/${name}`,
        shardedPackages: new Set(["@stll/api", "@stll/web"]),
      });
    expect(failure("web")).toBeUndefined();
    expect(failure("api")).toBeDefined();
  });

  check("matrix shard selection credits only command-executing legs", () => {
    const workflowFor = (shards: readonly string[], condition = "true") =>
      Bun.YAML.parse(`jobs:
  ci-tests:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: ${JSON.stringify(shards)}
    steps:
      - if: ${condition}
        env:
          SHARD: \${{ matrix.shard }}
        run: |
          read -r -a shard_args <<<"$(bun scripts/test-shards.ts --filters "$SHARD")"
          bun run test -- --concurrency=2 "\${shard_args[@]}"
  ci-result:
    needs: [ci-tests]
`);
    const selected = (workflow: unknown, name: string) =>
      packageTestExecutionFailure({
        rootScripts: { test: "turbo run test" },
        gatingJobs: analyzeGatingWorkflow(workflow).jobs,
        packageName: `@stll/${name}`,
        packageDirectory: `apps/${name}`,
        shardedPackages: new Set(["@stll/api", "@stll/web"]),
      });
    expect(selected(workflowFor(["web"]), "web")).toBeUndefined();
    expect(selected(workflowFor(["web"]), "api")).toBeDefined();
    expect(
      selected(workflowFor(["api-1", "web"], "matrix.shard == 'web'"), "api"),
    ).toBeDefined();
    expect(selected(workflowFor(["api-1", "web"]), "api")).toBeUndefined();
    const unknown = Bun.YAML.parse(`jobs:
  ci-tests:
    strategy:
      matrix: \${{ fromJSON(needs.other.outputs.matrix) }}
    steps:
      - run: bun --filter @stll/api test
  ci-result:
    needs: [ci-tests]
`);
    expect(analyzeGatingWorkflow(unknown).findings.join("\n")).toContain(
      "no proven shard set",
    );
    expect(selected(unknown, "api")).toBeDefined();
  });

  check("sharded runtime arguments require a recognized producer", () => {
    expect(
      packageTestExecutionFailure({
        rootScripts: { test: "turbo run test" },
        gatingJobs: bashJobs([
          [
            "ci-tests",
            [
              `bun run test -- --concurrency=2 "\${args[@]}" "\${shard_args[@]}"`,
            ],
          ],
        ]),
        packageName: "@stll/one",
        packageDirectory: "packages/one",
        shardedPackages: new Set(["@stll/one", "@stll/two"]),
      }),
    ).toContain("recognized producer");
  });

  check.each([
    ['bun test x.test.ts || { status=$?; echo failed; exit "$status"; }', true],
    ['bun test x.test.ts || { status=$?; status=0; exit "$status"; }', false],
    [
      'bun test x.test.ts || { status=$?; if false; then exit "$status"; fi; }',
      false,
    ],
    [
      'bun test x.test.ts || { echo failed; status=$?; exit "$status"; }',
      false,
    ],
    [
      'bun test x.test.ts || { status=$?; unset status; exit "$status"; }',
      false,
    ],
    [
      'bun test x.test.ts || { status=$?; if true; then exit "$status"; fi; }',
      false,
    ],
    ['bun test x.test.ts || { status=$?; set -e; exit "$status"; }', false],
    [
      'bun test x.test.ts || { status=$?; trap : EXIT; exit "$status"; }',
      false,
    ],
    ['bun test x.test.ts || { status=$?; exit 0; exit "$status"; }', false],
    ['bun test x.test.ts || { rc=$?; echo failed || true; exit "$rc"; }', true],
  ])(
    "fails closed on captured failure status fallbacks: %s",
    (command, gates) => {
      expect(
        rootCommandExecutionFailure({
          command: "bun test x.test.ts",
          gatingJobs: bashJobs([["checks", [command]]]),
        }) === undefined,
      ).toBe(gates);
    },
  );

  check(
    "resolves the root query-cache check without broadening its forwarded selection",
    () => {
      const topology = {
        workflow: "",
        gatingJobs: bashJobs([
          ["package-check", ["bun run check:query-cache-types"]],
        ]),
        shardedPackages: new Set<string>(),
      };
      expect(
        firstCollectionFailure({
          file: "packages/scripts/src/query-cache-types.test.ts",
          scenarios: new Map(),
          topology,
        }),
      ).toBeUndefined();
      expect(
        firstCollectionFailure({
          file: "packages/scripts/src/i18n-usage.test.ts",
          scenarios: new Map(),
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
        gatingJobs: bashJobs([
          ["package-check", ["bun --filter @stll/orphan test:smoke"]],
        ]),
        packageDirectory: "packages/orphan",
        packageName: "@stll/orphan",
        shardedPackages: new Set<string>(),
      }),
    ).toContain("job condition: no gating job executes @stll/orphan test");
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
    "set +o pipefail; RUNNER | cat",
    "helper() { true; }; RUNNER",
    "RUNNER || { exec true; exit 1; }",
    "RUNNER || exit 256",
  ])("failure-suppressed runners do not gate: %s", (shape) => {
    const packageCommand = shape.replace(
      "RUNNER",
      "bun --filter @stll/orphan test",
    );
    const serviceCommand = "bun run test:postgres";
    const packageFailure = packageTestExecutionFailure({
      gatingJobs: bashJobs([["package-check", [packageCommand]]]),
      packageDirectory: "packages/orphan",
      packageName: "@stll/orphan",
      shardedPackages: new Set<string>(),
    });
    const serviceFailure = managedServiceRunnerFailure({
      command: serviceCommand,
      gate: "STELLA_RUN_POSTGRES_TESTS",
      gatingJobs: bashJobs([
        ["service-suites", [shape.replace("RUNNER", () => serviceCommand)]],
      ]),
    });
    expect(packageFailure).toContain(
      "job condition: no gating job executes @stll/orphan test",
    );
    expect(packageFailure).toContain("shell condition:");
    expect(serviceFailure).toContain(
      "job condition: no gating job executes the STELLA_RUN_POSTGRES_TESTS runner",
    );
    expect(serviceFailure).toContain("shell condition:");
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
      bashJobs([["checks", [shape.replace("RUNNER", () => runner)]]]);
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
  ])("checks runner ownership after a known safe prefix: %s", (prefix) => {
    const failure = rootCommandExecutionFailure({
      command: "bun scripts/test-gate.ts",
      gatingJobs: bashJobs([
        ["checks", [`${prefix} && bun scripts/test-gate.ts`]],
      ]),
    });
    if (prefix === "cd packages/fixture") {
      expect(failure).toBeDefined();
    } else {
      expect(failure).toBeUndefined();
    }
  });

  check(
    "literal directory changes preserve package and workspace script invocations",
    () => {
      for (const command of [
        "cd packages/fixture && bun run test",
        "cd packages/fixture && bun --filter @stll/fixture test",
      ]) {
        expect(
          packageTestExecutionFailure({
            packageDirectory: "packages/fixture",
            packageName: "@stll/fixture",
            shardedPackages: new Set<string>(),
            gatingJobs: bashJobs([["checks", [command]]]),
          }),
        ).toBeUndefined();
      }
    },
  );

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
    "set +o pipefail; RUNNER | cat",
    "set +e; set -e; RUNNER",
    "set +o errexit; RUNNER",
    "shopt -s inherit_errexit; RUNNER",
    "trap 'exit 0' ERR; RUNNER",
    "eval 'true'; RUNNER",
    ". ./setup.sh; RUNNER",
    "source ./setup.sh; RUNNER",
    "if true; then RUNNER; fi",
    "case ready in ready) RUNNER;; esac",
    "while true; do RUNNER; done",
    "until false; do RUNNER; done",
    "for item in one; do RUNNER; done",
    "(RUNNER)",
    "run_runner() { RUNNER; }; run_runner",
    "RUNNER || { if false; then exit 1; fi; }",
    "RUNNER || { if true; then exit 1; fi; }",
    'RUNNER || { echo failed; status=$?; exit "$status"; }',
    'RUNNER || { status=$?; status=0; exit "$status"; }',
    'RUNNER || { status=$?; echo "$((status=0))"; exit "$status"; }',
    'RUNNER || { status=$?; unset status; exit "$status"; }',
    'RUNNER || { status=$?; if true; then exit "$status"; fi; }',
    'RUNNER || { status=$?; set -e; exit "$status"; }',
    'RUNNER || { status=$?; trap : EXIT; exit "$status"; }',
    'RUNNER || { status=$?; exit 0; exit "$status"; }',
    "RUNNER || false",
    "RUNNER || { false; }",
  ])("fails closed on shell control flow: %s", (shape) => {
    const gatingJobs = (runner: string) =>
      bashJobs([["checks", [shape.replace("RUNNER", () => runner)]]]);
    const packageFailure = packageTestExecutionFailure({
      gatingJobs: gatingJobs("bun --filter @stll/orphan test"),
      packageDirectory: "packages/orphan",
      packageName: "@stll/orphan",
      shardedPackages: new Set<string>(),
    });
    expect(packageFailure).toContain(
      "job condition: no gating job executes @stll/orphan test",
    );
    expect(packageFailure).toContain("shell condition:");
    const rootFailure = rootCommandExecutionFailure({
      command: "bun scripts/test-gate.ts",
      gatingJobs: gatingJobs("bun scripts/test-gate.ts"),
    });
    expect(rootFailure).toContain(
      "job condition: no gating job executes bun scripts/test-gate.ts",
    );
    expect(rootFailure).toContain("shell condition:");
    const serviceFailure = managedServiceRunnerFailure({
      command: "bun run test:postgres",
      gate: "STELLA_RUN_POSTGRES_TESTS",
      gatingJobs: gatingJobs("bun run test:postgres"),
    });
    expect(serviceFailure).toContain(
      "job condition: no gating job executes the STELLA_RUN_POSTGRES_TESTS runner",
    );
    expect(serviceFailure).toContain("shell condition:");
  });

  check.each([
    "echo set +e; RUNNER",
    "RUNNER || { exit 1; }",
    "RUNNER || { true; exit 1; }",
    'RUNNER || { status=$?; echo failed; exit "$status"; }',
    'RUNNER || { rc=$?; echo failed || true; exit "$rc"; }',
  ])("preserves failure-propagating runners: %s", (shape) => {
    const serviceCommand = "bun run test:postgres";
    expect([
      packageTestExecutionFailure({
        gatingJobs: bashJobs([
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
        gatingJobs: bashJobs([
          ["service-suites", [shape.replace("RUNNER", () => serviceCommand)]],
        ]),
      }),
      rootCommandExecutionFailure({
        command: "bun scripts/test-gate.ts",
        gatingJobs: bashJobs([
          ["checks", [shape.replace("RUNNER", "bun scripts/test-gate.ts")]],
        ]),
      }),
    ]).toEqual([undefined, undefined, undefined]);
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
    ).toContain("job condition: no gating job executes @stll/orphan test");
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
    ).toContain("job condition: no gating job executes @stll/orphan test");
  });

  check(
    "later includes overwrite added fields without creating another axis leg",
    () => {
      const analysis = analyzeGatingWorkflow(
        {
          jobs: {
            checks: {
              "runs-on": "ubuntu-latest",
              strategy: {
                matrix: {
                  os: ["ubuntu-latest"],
                  include: [{ color: "green" }, { color: "pink" }],
                },
              },
              steps: [
                {
                  if: "matrix.color == 'green'",
                  run: "bun test scripts/green.test.ts",
                },
                {
                  if: "matrix.color == 'pink'",
                  run: "bun test scripts/pink.test.ts",
                  env: { COLOR: `\${{ matrix.color }}` },
                },
              ],
            },
            "ci-result": { needs: ["checks"] },
          },
        },
        [],
      );
      const commands = analysis.jobs.get("checks") ?? [];
      expect(commands.map(({ command }) => command)).toEqual([
        "bun test scripts/pink.test.ts",
      ]);
      expect(commands.at(0)?.environment["COLOR"]).toBe("pink");
    },
  );

  check(
    "matrix includes follow original combinations in the documented fruit example",
    () => {
      const analysis = analyzeGatingWorkflow(
        {
          jobs: {
            checks: {
              "runs-on": "ubuntu-latest",
              strategy: {
                matrix: {
                  fruit: ["apple", "pear"],
                  animal: ["cat", "dog"],
                  include: [
                    { color: "green" },
                    { color: "pink", animal: "cat" },
                    { fruit: "apple", shape: "circle" },
                    { fruit: "banana" },
                    { fruit: "banana", animal: "cat" },
                  ],
                },
              },
              steps: [
                {
                  run: "bun test scripts/named.test.ts",
                  env: {
                    fruit: `\${{ matrix.fruit }}`,
                    animal: `\${{ matrix.animal }}`,
                    color: `\${{ matrix.color }}`,
                    shape: `\${{ matrix.shape }}`,
                  },
                },
              ],
            },
            "ci-result": { needs: ["checks"] },
          },
        },
        [],
      );
      const legs = (analysis.jobs.get("checks") ?? []).map(({ environment }) =>
        Object.fromEntries(
          Object.entries(environment).filter(
            ([, value]) => typeof value === "string",
          ),
        ),
      );
      expect(legs).toEqual([
        { fruit: "apple", animal: "cat", color: "pink", shape: "circle" },
        { fruit: "apple", animal: "dog", color: "green", shape: "circle" },
        { fruit: "pear", animal: "cat", color: "pink" },
        { fruit: "pear", animal: "dog", color: "green" },
        { fruit: "banana" },
        { fruit: "banana", animal: "cat" },
      ]);
    },
  );

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
        const failure = rootCommandExecutionFailure({
          command: "bun scripts/test-gate.ts",
          gatingJobs: gatingWorkflowJobs(workflow),
        });
        expect(failure).toContain(
          "job condition: no gating job executes bun scripts/test-gate.ts",
        );
        expect(failure).toContain("shell condition:");
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
      "job condition: package-check/step-1 has unresolved context unresolved condition disjuncts: unresolved condition atom: matrix.os == 'macos'",
    ]);
  });

  check("counts step outcomes on the successful runtime path", () => {
    const workflow = Bun.YAML.parse(`
jobs:
  package-check:
    steps:
      - id: install
        run: echo installed
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
    "platform conditionals require the exact skip and a non-Windows collector",
    () => {
      const file = "scripts/named.test.ts";
      const source = `import { test } from "bun:test"; test.skipIf(process.platform === "win32")("platform probe", () => {});`;
      const entry = {
        identity: `${file}::platform probe`,
        kind: "platform-conditional",
        skippedOn: ["win32"],
      } as const;
      const workflowFor = (runner: string) => `jobs:
  checks:
    runs-on: ${runner}
    shell: bash
    steps:
      - run: bun test scripts/named.test.ts
  ci-result:
    needs: [checks]
`;
      const validate = (candidateSource: string, runner: string) => {
        const workflow = workflowFor(runner);
        return platformConditionalFailure({
          entry,
          file,
          source: candidateSource,
          topology: {
            workflow,
            gatingJobs: analyzeGatingWorkflow(Bun.YAML.parse(workflow)).jobs,
            shardedPackages: new Set<string>(),
          },
        });
      };
      expect(
        parseDisabledLedger({ managedServiceGates: [], identities: [entry] })
          .platformConditionals,
      ).toEqual([entry]);
      expect(validate(source, "ubuntu-latest")).toBeUndefined();
      for (const condition of [
        'process.platform !== "linux"',
        "true",
        "disabled",
        'process.platform == "win32"',
      ]) {
        expect(
          validate(
            source.replace('process.platform === "win32"', () => condition),
            "ubuntu-latest",
          ),
        ).toContain("skipIf must use literal");
      }
      expect(
        validate(source.replace("skipIf", "skip"), "ubuntu-latest"),
      ).toContain("skipIf must use literal");
      expect(validate(source, "windows-latest")).toContain(
        "no proven non-win32 gating collector",
      );
    },
  );

  check("structured blockers expire with their named producer", () => {
    const workflow = `jobs:
  ci-browser:
    steps:
      - id: ui-browser-tests
        run: echo 'required=true' >> "$GITHUB_OUTPUT"
`;
    const step = {
      id: "ui-browser-tests",
      run: "echo 'required=true' >> \"$GITHUB_OUTPUT\"",
    };
    const selection = {
      blocker: "unproven-selection-producer",
      producer:
        ".github/workflows/ci.yml/ci-browser/ui-browser-tests.outputs.required",
      producerSha256: sha256Hex(JSON.stringify(step)),
    } as const satisfies ScenarioBlocker;
    const action =
      "outputs:\n  status:\n    value: ready\nruns:\n  using: composite\n  steps: []\n";
    const stack = {
      blocker: "stack-status-gate",
      producer: "setup-e2e-stack status",
      producerSha256: sha256Hex(action),
    } as const satisfies ScenarioBlocker;
    expect(scenarioBlockerFailure(selection, () => workflow)).toBeUndefined();
    expect(scenarioBlockerFailure(stack, () => action)).toBeUndefined();
    for (const mutated of [
      workflow.replace("id: ui-browser-tests", "id: renamed"),
      workflow.replace("required=true", "renamed=true"),
      workflow.replace("true", "false"),
    ]) {
      expect(scenarioBlockerFailure(selection, () => mutated)).toContain(
        "scenario blocker:",
      );
    }
    expect(scenarioBlockerFailure(selection, () => undefined)).toContain(
      "producer is missing",
    );
    expect(
      scenarioBlockerFailure(stack, () =>
        action.replace("status:", "renamed:"),
      ),
    ).toContain("output is missing");
    expect(
      scenarioBlockerFailure(stack, () => `${action}# changed\n`),
    ).toContain("producer changed");
    const scenario = {
      type: "non-gating",
      file: "scripts/named.test.ts",
      owningWorkflow: ".github/workflows/ci.yml",
      reason: selection,
    } as const satisfies TestScenario;
    expect(parseScenarioLedger([scenario])).toEqual([scenario]);
    expect(() =>
      parseScenarioLedger([
        { ...scenario, reason: { ...selection, blocker: "unreviewed" } },
      ]),
    ).toThrow("invalid structured blocker");
  });

  check.each(["true", "false", "composite"])(
    "job output aliases share producer constraints: %s",
    (value) => {
      const registry = [
        {
          workflow: ".github/workflows/ci.yml",
          job: "ci-plan",
          stepId: "selection",
          outputNames: ["required"],
          semantics: "selection",
          proofTest: "scripts/ci-plan.test.ts",
        },
      ] as const satisfies readonly TrustedOutputProducer[];
      const source = `jobs:
  ci-plan:
    outputs:
      selected_a: \${{ steps.selection.outputs.required }}
      selected_b: \${{ ${value === "composite" ? "steps.selection.outputs.required == 'true'" : "steps.selection.outputs.required"} }}
    steps:
      - id: selection
        run: echo 'required=true' >> "$GITHUB_OUTPUT"
  checks:
    if: needs.ci-plan.outputs.selected_a == 'true'
    steps:
      - if: needs.ci-plan.outputs.selected_b == '${value === "true" ? "true" : "false"}'
        run: bun test scripts/named.test.ts
  proof:
    runs-on: ubuntu-latest
    steps:
      - run: bun test scripts/ci-plan.test.ts
  ci-result:
    needs: [ci-plan, checks, proof]
`;
      const workflow = Bun.YAML.parse(source);
      const analysis = analyzeGatingWorkflow(workflow, registry);
      const declarations = validateTrustedOutputProducers({
        workflow,
        registry,
      });
      const producers = declarations.producers.get("checks");
      if (value === "composite") {
        expect(producers?.has("needs.ci-plan.outputs.selected_b")).toBe(false);
        expect(
          declarations.substitutions.has("needs.ci-plan.outputs.selected_b"),
        ).toBe(true);
        expect(analysis.findings.join("\n")).toContain(
          "contradictory trusted output constraints",
        );
      } else {
        expect(producers?.get("needs.ci-plan.outputs.selected_a")).toBe(
          producers?.get("needs.ci-plan.outputs.selected_b"),
        );
      }
      expect(analysis.jobs.has("checks")).toBe(value === "true");
      const failure = firstCollectionFailure({
        file: "scripts/named.test.ts",
        scenarios: new Map(),
        topology: {
          workflow: source,
          gatingJobs: analysis.jobs,
          shardedPackages: new Set<string>(),
        },
      });
      if (value !== "true") {
        expect(failure).toBeDefined();
      } else {
        expect(failure).toBeUndefined();
      }
    },
  );

  check.each([
    {
      name: "satisfiable composite",
      expression: "steps.selection.outputs.required == 'true'",
      extra: "",
      credited: true,
      reason: undefined,
      events: undefined,
    },
    {
      name: "function call",
      expression: "contains(steps.selection.outputs.required, 'true')",
      extra: "",
      credited: false,
      reason: "may be an empty or non-boolean string",
      events: undefined,
    },
    {
      name: "alias cycle",
      expression: "needs.ci-plan.outputs.loop",
      extra: `loop: \${{ needs.ci-plan.outputs.selected_b }}`,
      credited: false,
      reason: "alias cycle",
      events: undefined,
    },
    {
      name: "bound variable",
      expression:
        "vars.QUEUE_BROWSER_SUITES != 'off' && steps.selection.outputs.required == 'true'",
      extra: "",
      credited: true,
      reason: undefined,
      events: undefined,
    },
    {
      name: "unbound variable",
      expression:
        "vars.UNBOUND_SELECTION == 'on' && steps.selection.outputs.required == 'true'",
      extra: "",
      credited: false,
      reason: "unsupported atom",
      events: undefined,
    },
    {
      name: "merge-group alternative to an unknown variable",
      expression:
        "github.event_name == 'merge_group' || vars.UNBOUND_SELECTION == 'on' && steps.selection.outputs.required == 'true'",
      extra: "",
      credited: true,
      reason: undefined,
      events: ["merge_group"],
    },
    {
      name: "merge-group alternative to a negated unknown variable",
      expression:
        "github.event_name == 'merge_group' || !(vars.UNBOUND_SELECTION == 'on') && steps.selection.outputs.required == 'true'",
      extra: "",
      credited: true,
      reason: undefined,
      events: ["merge_group"],
    },
  ])(
    "substituted job output: $name",
    ({ expression, extra, credited, reason, events }) => {
      const registry = [
        {
          workflow: ".github/workflows/ci.yml",
          job: "ci-plan",
          stepId: "selection",
          outputNames: ["required"],
          semantics: "selection",
          proofTest: "scripts/ci-plan.test.ts",
        },
      ] as const satisfies readonly TrustedOutputProducer[];
      const workflow = Bun.YAML.parse(`jobs:
  ci-plan:
    outputs:
      selected_a: \${{ steps.selection.outputs.required }}
      selected_b: \${{ ${expression} }}
      ${extra}
    steps:
      - id: selection
        run: echo 'required=true' >> "$GITHUB_OUTPUT"
  checks:
    if: needs.ci-plan.outputs.selected_a == 'true'
    steps:
      - if: needs.ci-plan.outputs.selected_b == 'true'
        run: bun test scripts/named.test.ts
  proof:
    steps:
      - run: bun test scripts/ci-plan.test.ts
  ci-result:
    needs: [ci-plan, checks, proof]
`);
      const analysis = analyzeGatingWorkflow(workflow, registry);
      expect(analysis.jobs.has("checks")).toBe(credited);
      if (events !== undefined) {
        expect(analysis.jobs.get("checks")?.at(0)?.events).toEqual(events);
      }
      if (reason !== undefined) {
        expect(analysis.findings.join("\n")).toContain(reason);
      }
    },
  );

  check.each([
    ["!needs.plan.outputs.selected", false],
    ["needs.plan.outputs.selected", true],
    ["needs.plan.outputs.selected == 'false'", true],
    ["needs.plan.outputs.selected == 'true'", false],
  ] as const)(
    "composite output string condition: %s",
    (condition, credited) => {
      const analysis = analyzeGatingWorkflow(
        {
          jobs: {
            plan: {
              outputs: { selected: `\${{ false }}` },
              steps: [{ run: "echo plan" }],
            },
            checks: {
              "runs-on": "ubuntu-latest",
              steps: [{ if: condition, run: "bun test scripts/named.test.ts" }],
            },
            "ci-result": { needs: ["plan", "checks"] },
          },
        },
        [],
      );
      expect(analysis.jobs.has("checks")).toBe(credited);
    },
  );

  check.each([
    {
      condition: "steps.missing.outcome == 'success'",
      preceding: [],
      following: [],
      credited: false,
    },
    {
      condition: "steps.later.outcome == 'success'",
      preceding: [],
      following: [{ id: "later", run: "true" }],
      credited: false,
    },
    {
      condition: "steps.prep.outcome == 'success'",
      preceding: [{ id: "prep", run: "true" }],
      following: [],
      credited: true,
    },
    {
      condition: "steps.prep.outcome == 'success'",
      preceding: [{ id: "prep", if: false, run: "true" }],
      following: [],
      credited: false,
    },
    {
      condition: "steps.prep.outcome == 'success'",
      preceding: [{ id: "prep", "continue-on-error": true, run: "true" }],
      following: [],
      credited: false,
    },
    {
      condition: "github.ref == 'refs/heads/main'",
      preceding: [],
      following: [],
      credited: false,
    },
    {
      condition: "github.event_name == 'merge_group'",
      preceding: [],
      following: [],
      credited: true,
    },
    {
      condition: "startsWith(github.ref, 'refs/heads/gh-readonly-queue/main/')",
      preceding: [],
      following: [],
      credited: true,
    },
    {
      condition: "github.actor == 'maintainer'",
      preceding: [],
      following: [],
      credited: false,
    },
    {
      condition:
        "github.event_name == 'pull_request' && github.event.pull_request.draft == false",
      preceding: [],
      following: [],
      credited: true,
    },
  ])(
    "gating event and prior step reachability: $condition",
    ({ condition, preceding, following, credited }) => {
      const analysis = analyzeGatingWorkflow(
        {
          jobs: {
            checks: {
              "runs-on": "ubuntu-latest",
              steps: [
                ...preceding,
                { if: condition, run: "bun test scripts/named.test.ts" },
                ...following,
              ],
            },
            "ci-result": { needs: ["checks"] },
          },
        },
        [],
      );
      const commands = analysis.jobs.get("checks") ?? [];
      expect(
        commands.some(({ command }) => command.includes("named.test.ts")),
      ).toBe(credited);
      if (!credited) {
        expect(analysis.findings.length).toBeGreaterThan(0);
      }
    },
  );

  check.each(["outcome", "conclusion"])(
    "only proven earlier skips resolve steps.*.%s",
    (member) => {
      const runner = "bun test scripts/named.test.ts";
      const cases = [
        { earlier: [], later: [], credited: false, events: undefined },
        {
          earlier: [],
          later: [{ id: "prep", run: "echo later" }],
          credited: false,
          events: undefined,
        },
        {
          earlier: [{ id: "prep", if: false, run: "echo skipped" }],
          later: [],
          credited: true,
          events: ["pull_request", "merge_group"],
        },
        {
          earlier: [
            {
              id: "prep",
              if: "github.event_name == 'pull_request'",
              run: "echo selected",
            },
          ],
          later: [],
          credited: true,
          events: ["merge_group"],
        },
        {
          earlier: [
            { id: "prep", if: "vars.UNRESOLVED == 'on'", run: "echo unknown" },
          ],
          later: [],
          credited: false,
          events: undefined,
        },
      ] as const;
      for (const { earlier, later, credited, events } of cases) {
        const analysis = analyzeGatingWorkflow(
          {
            jobs: {
              checks: {
                "runs-on": "ubuntu-latest",
                steps: [
                  ...earlier,
                  { if: `steps.prep.${member} == 'skipped'`, run: runner },
                  ...later,
                ],
              },
              "ci-result": { needs: ["checks"] },
            },
          },
          [],
        );
        const command = analysis.jobs
          .get("checks")
          ?.find(({ command: candidate }) => candidate === runner);
        expect(command !== undefined).toBe(credited);
        if (events !== undefined) {
          expect(command?.events).toEqual(events);
        } else {
          expect(analysis.findings.join("\n")).toContain(
            `steps.prep.${member}`,
          );
        }
      }
    },
  );

  check("process facts must be read by a real workflow condition", () => {
    const workflow = {
      jobs: {
        checks: { if: "github.event.pull_request.draft != true", steps: [] },
      },
    };
    const facts = {
      pull_request: { "github.event.pull_request.draft": false },
    };
    expect(validateGatingEventFacts(workflow, facts)).toEqual([]);
    expect(
      validateGatingEventFacts(workflow, {
        pull_request: { ...facts.pull_request, "github.actor": "unused" },
      }),
    ).toContain("gating event fact: pull_request/github.actor is unused");
    expect(
      validateGatingEventFacts(
        Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf-8")),
      ),
    ).toEqual([]);
  });

  check("trusted output producers keep their named producer and proof", () => {
    const registry = [
      {
        workflow: ".github/workflows/ci.yml",
        job: "ci-plan",
        stepId: "selection",
        outputNames: ["required"],
        semantics: "selection",
        proofTest: "scripts/ci-plan.test.ts",
      },
    ] as const satisfies readonly TrustedOutputProducer[];
    const source = `jobs:
  ci-plan:
    outputs:
      selected: \${{ steps.selection.outputs.required }}
    steps:
      - id: selection
        run: echo 'required=true' >> "$GITHUB_OUTPUT"
  checks:
    if: needs.ci-plan.outputs.selected == 'true'
    steps:
      - run: bun test scripts/named.test.ts
  proof:
    runs-on: ubuntu-latest
    steps:
      - run: bun test scripts/ci-plan.test.ts
  ci-result:
    needs: [ci-plan, checks, proof]
`;
    const intact = Bun.YAML.parse(source);
    const failureTolerant = Bun.YAML.parse(
      source.replace(
        "- id: selection",
        "- id: selection\n        continue-on-error: true",
      ),
    );
    expect(
      validateTrustedOutputProducers({ workflow: failureTolerant, registry })
        .findings,
    ).toContain(
      "trusted output producer: ci-plan/selection uses continue-on-error",
    );
    expect(
      analyzeGatingWorkflow(failureTolerant, registry).jobs.has("checks"),
    ).toBe(false);
    expect(
      validateTrustedOutputProducers({ workflow: intact, registry }).findings,
    ).toEqual([]);
    expect(analyzeGatingWorkflow(intact, registry).jobs.has("checks")).toBe(
      true,
    );
    for (const [stepCondition, expected, reason] of [
      [
        "needs.ci-plan.outputs.selected == 'false'",
        false,
        "contradictory trusted output constraints",
      ],
      [
        "needs.ci-plan.outputs.selected != 'true'",
        false,
        "contradictory trusted output constraints",
      ],
      ["needs.ci-plan.outputs.selected == 'true'", true, ""],
      [
        "!(needs.ci-plan.outputs.selected == 'true')",
        false,
        "contradictory trusted output constraints",
      ],
      ["needs.ci-plan.outputs.selected == 'true' || success()", true, ""],
      [
        Array.from(
          { length: 7 },
          (_, index) =>
            `(github.field${index} == 'a' || github.field${index} == 'b')`,
        ).join(" && "),
        false,
        "output condition DNF exceeds 64 disjuncts",
      ],
    ] as const) {
      const workflow = Bun.YAML.parse(
        source.replace(
          "      - run: bun test scripts/named.test.ts",
          () =>
            `      - if: ${JSON.stringify(stepCondition)}\n        run: bun test scripts/named.test.ts`,
        ),
      );
      const analysis = analyzeGatingWorkflow(workflow, registry);
      expect(analysis.jobs.has("checks"), stepCondition).toBe(expected);
      if (!expected) {
        expect(analysis.findings.join("\n")).toContain(reason);
      }
      const failure = firstCollectionFailure({
        file: "scripts/named.test.ts",
        scenarios: new Map(),
        topology: {
          workflow: JSON.stringify(workflow),
          gatingJobs: analysis.jobs,
          shardedPackages: new Set<string>(),
        },
      });
      if (expected) {
        expect(failure).toBeUndefined();
      } else {
        expect(failure).toBeDefined();
      }
    }
    expect(
      validateTrustedOutputProducers({
        workflow: Bun.YAML.parse(
          source.replace(
            "if: needs.ci-plan.outputs.selected == 'true'",
            "if: true",
          ),
        ),
        registry,
      }).findings.join("\n"),
    ).toContain("output has no collector condition reader");
    const circular = Bun.YAML.parse(
      source
        .replace("required=true", "required=false")
        .replace(
          "      - run: bun test scripts/ci-plan.test.ts",
          "      - if: needs.ci-plan.outputs.selected == 'true'\n        run: bun test scripts/ci-plan.test.ts",
        ),
    );
    expect(
      analyzeGatingWorkflow(circular, registry).findings.join("\n"),
    ).toContain("no independent gating collector");
    expect(analyzeGatingWorkflow(circular, registry).jobs.has("checks")).toBe(
      false,
    );
    const withoutProof = Bun.YAML.parse(
      source.replace("      - run: bun test scripts/ci-plan.test.ts\n", ""),
    );
    expect(
      analyzeGatingWorkflow(withoutProof, registry).findings.join("\n"),
    ).toContain("proof test has no independent gating collector");
    expect(
      analyzeGatingWorkflow(withoutProof, registry).jobs.has("checks"),
    ).toBe(false);
    for (const [mutation, reason] of [
      [source.replace("id: selection", "id: removed"), "step is missing"],
      [
        source.replace("required=true", "renamed=true"),
        "output is missing or renamed",
      ],
    ] as const) {
      const workflow = Bun.YAML.parse(mutation);
      expect(
        validateTrustedOutputProducers({ workflow, registry }).findings.join(
          "\n",
        ),
      ).toContain(reason);
      expect(analyzeGatingWorkflow(workflow, registry).jobs.has("checks")).toBe(
        false,
      );
    }
    expect(
      validateTrustedOutputProducers({
        workflow: intact,
        registry: [
          {
            ...registry[0],
            proofTest: "scripts/missing-proof.test.ts",
          },
        ],
      }).findings.join("\n"),
    ).toContain("proof test is missing");
  });

  check("registered repository producers still declare their outputs", () => {
    const workflow = Bun.YAML.parse(
      readFileSync(".github/workflows/ci.yml", "utf-8"),
    );
    expect(
      validateTrustedOutputProducers({
        workflow,
        registry: TRUSTED_OUTPUT_PRODUCERS,
      }).findings,
    ).toEqual([]);
  });

  check("unspecified Linux shell does not propagate pipeline failures", () => {
    const workflow = Bun.YAML.parse(`jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - run: bun test scripts/named.test.ts | cat
  ci-result:
    needs: [checks]
`);
    const topology = analyzeGatingWorkflow(workflow);
    expect(topology.jobs.get("checks")?.at(0)?.propagation).toEqual({
      errexit: true,
      pipefail: false,
    });
    expect(
      firstCollectionFailure({
        file: "scripts/named.test.ts",
        scenarios: new Map(),
        topology: {
          workflow: Bun.YAML.stringify(workflow),
          gatingJobs: topology.jobs,
          shardedPackages: new Set<string>(),
        },
      }),
    ).toContain("pipeline failure propagation is disabled");
  });

  check.each([
    ["steps.setup.outputs.run_tests == 'true'", false],
    ["needs.setup.outputs.run_tests == 'true'", false],
    ["true || steps.setup.outputs.run_tests == 'true'", true],
    ["needs.ci-plan.outputs.package_checks_required == 'true'", true],
  ])(
    "output condition %s requires a resolved execution path",
    (condition, credited) => {
      const workflow = Bun.YAML.parse(`jobs:
  ci-plan:
    outputs:
      package_checks_required: \${{ steps.selection.outputs.required }}
    steps:
      - id: selection
        run: echo 'required=true' >> "$GITHUB_OUTPUT"
      - run: bun test scripts/ci-plan.test.ts
  checks:
    runs-on: ubuntu-latest
    steps:
      - id: setup
        run: echo 'run_tests=false' >> "$GITHUB_OUTPUT"
      - if: \${{ ${condition} }}
        run: bun test scripts/named.test.ts
  ci-result:
    needs: [ci-plan, checks]
`);
      const topology = analyzeGatingWorkflow(workflow, [
        {
          workflow: ".github/workflows/ci.yml",
          job: "ci-plan",
          stepId: "selection",
          outputNames: ["required"],
          semantics: "selection",
          proofTest: "scripts/ci-plan.test.ts",
        },
      ]);
      const failure = firstCollectionFailure({
        file: "scripts/named.test.ts",
        scenarios: new Map(),
        topology: {
          workflow: Bun.YAML.stringify(workflow),
          gatingJobs: topology.jobs,
          shardedPackages: new Set<string>(),
        },
      });
      if (credited) {
        expect(failure).toBeUndefined();
      } else {
        expect(failure).toBeDefined();
        expect(topology.findings.join("\n")).toContain("unresolved context");
      }
    },
  );

  check(
    "resolves effective workflow shells and their failure propagation",
    () => {
      const command = "bun --filter @stll/orphan test | cat";
      const run = (defaults: string, stepShell: string) =>
        Bun.YAML.parse(`
defaults:
  run:
    shell: ${defaults}
jobs:
  package-check:
    defaults:
      run:
        shell: bash -e {0}
    steps:
      - run: ${command}
        shell: ${stepShell}
  ci-result:
    needs: [package-check]
`);
      const bashZero = Bun.YAML.parse(`
jobs:
  package-check:
    defaults:
      run:
        shell: bash {0}
    steps:
      - run: ${command}
  ci-result:
    needs: [package-check]
`);
      expect(
        packageTestExecutionFailure({
          gatingJobs: gatingWorkflowJobs(bashZero),
          packageDirectory: "packages/orphan",
          packageName: "@stll/orphan",
          shardedPackages: new Set<string>(),
        }),
      ).toContain("job condition: no gating job executes @stll/orphan test");

      const literalBash = Bun.YAML.parse(`
jobs:
  package-check:
    defaults:
      run:
        shell: bash
    steps:
      - run: ${command}
  ci-result:
    needs: [package-check]
`);
      expect(
        packageTestExecutionFailure({
          gatingJobs: gatingWorkflowJobs(literalBash),
          packageDirectory: "packages/orphan",
          packageName: "@stll/orphan",
          shardedPackages: new Set<string>(),
        }),
      ).toBeUndefined();

      const precedence = analyzeGatingWorkflow(
        run("bash {0}", "bash {0}"),
      ).jobs.get("package-check");
      expect(precedence?.map(({ propagation }) => propagation)).toEqual([
        { errexit: false, pipefail: false },
      ]);
      expect(
        analyzeGatingWorkflow(
          run("bash {0}", "bash --noprofile --norc -eo pipefail {0}"),
        )
          .jobs.get("package-check")
          ?.at(0)?.propagation,
      ).toEqual({ errexit: true, pipefail: true });
      const jobShell = analyzeGatingWorkflow(
        Bun.YAML.parse(`
defaults:
  run:
    shell: bash {0}
jobs:
  package-check:
    defaults:
      run:
        shell: bash -e {0}
    steps:
      - run: ${command}
  ci-result:
    needs: [package-check]
`),
      ).jobs.get("package-check");
      expect(jobShell?.at(0)?.propagation).toEqual({
        errexit: true,
        pipefail: false,
      });
      const workflowShell = analyzeGatingWorkflow(
        Bun.YAML.parse(`
defaults:
  run:
    shell: bash {0}
jobs:
  package-check:
    steps:
      - run: ${command}
  ci-result:
    needs: [package-check]
`),
      ).jobs.get("package-check");
      expect(workflowShell?.at(0)?.propagation).toEqual({
        errexit: false,
        pipefail: false,
      });
      const shellWorkflow = (shell: string, runCommand = command) =>
        Bun.YAML.parse(`
jobs:
  package-check:
    defaults:
      run:
        shell: ${shell}
    steps:
      - run: ${runCommand}
  ci-result:
    needs: [package-check]
`);
      for (const shell of [
        "bash +o pipefail {0}",
        "bash --noprofile --norc +o pipefail {0}",
      ]) {
        expect(
          packageTestExecutionFailure({
            gatingJobs: gatingWorkflowJobs(shellWorkflow(shell)),
            packageDirectory: "packages/orphan",
            packageName: "@stll/orphan",
            shardedPackages: new Set<string>(),
          }),
          shell,
        ).toContain("job condition: no gating job executes @stll/orphan test");
      }
      expect(
        packageTestExecutionFailure({
          gatingJobs: gatingWorkflowJobs(
            shellWorkflow(
              "bash +e {0}",
              "bun --filter @stll/orphan test; echo finished",
            ),
          ),
          packageDirectory: "packages/orphan",
          packageName: "@stll/orphan",
          shardedPackages: new Set<string>(),
        }),
      ).toContain("job condition: no gating job executes @stll/orphan test");
      expect(
        analyzeGatingWorkflow(shellWorkflow("bash notpipefail {0}")).findings,
      ).toEqual([
        "job condition: package-check/step-1 uses unsupported shell bash notpipefail {0}",
      ]);
    },
  );

  check("names workflow steps whose shell is unsupported", () => {
    const analysis = analyzeGatingWorkflow(
      Bun.YAML.parse(`
jobs:
  package-check:
    steps:
      - run: bun --filter @stll/orphan test
        shell: sh {0}
  ci-result:
    needs: [package-check]
`),
    );
    expect(analysis.findings).toEqual([
      "job condition: package-check/step-1 uses unsupported shell sh {0}",
    ]);
    expect(analysis.jobs.size).toBe(0);
  });

  check("reports unsupported shells only for test collector commands", () => {
    const analyze = (
      run: string,
      shell = "pwsh {0}",
      runner = "ubuntu-latest",
    ) =>
      analyzeGatingWorkflow(
        Bun.YAML.parse(`
jobs:
  checks:
    runs-on: ${runner}
    steps:
      - run: ${run}
        shell: ${shell}
  ci-result:
    needs: [checks]
`),
      );

    for (const analysis of [
      analyze("bun scripts/check-windows-script-standards.ts"),
      analyze(
        "bun scripts/check-windows-script-standards.ts",
        "pwsh {0}",
        "windows-latest",
      ),
    ]) {
      expect(analysis.findings).toEqual([]);
      expect(analysis.jobs.size).toBe(0);
    }

    for (const command of [
      "bun test x.test.ts",
      "bun --filter @stll/extension test",
      "bun run test",
      "playwright test",
    ]) {
      const analysis = analyze(command);
      expect(analysis.findings, command).toContain(
        "job condition: checks/step-1 uses unsupported shell pwsh {0}",
      );
      expect(analysis.jobs.size, command).toBe(0);
    }

    const echoed = analyze('echo "bun test x.test.ts"');
    expect(echoed.findings).toEqual([]);
    expect(echoed.jobs.size).toBe(0);

    const alternativeWorkflow = `jobs:
  windows-tests:
    runs-on: windows-latest
    steps:
      - run: bun test scripts/test-gate.test.ts
        shell: pwsh {0}
  linux-tests:
    runs-on: ubuntu-latest
    steps:
      - run: bun test scripts/test-gate.test.ts
  ci-result:
    needs: [windows-tests, linux-tests]
`;
    const alternativeAnalysis = analyzeGatingWorkflow(
      Bun.YAML.parse(alternativeWorkflow),
    );
    expect(alternativeAnalysis.findings).toContain(
      "job condition: windows-tests/step-1 uses unsupported shell pwsh {0}",
    );
    expect(
      firstCollectionFailure({
        file: "scripts/test-gate.test.ts",
        scenarios: new Map(),
        topology: {
          gatingJobs: alternativeAnalysis.jobs,
          shardedPackages: new Set<string>(),
          workflow: alternativeWorkflow,
        },
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
      ).toContain("job condition: no gating job executes @stll/orphan test");
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
        `job condition: package-check/step-1 has unresolved context unresolved condition disjuncts: unresolved condition atom: vars.SOME_TOGGLE == '${value}'`,
      ]);
      expect(
        packageTestExecutionFailure({
          gatingJobs: analysis.jobs,
          packageDirectory: "packages/orphan",
          packageName: "@stll/orphan",
          shardedPackages: new Set<string>(),
        }),
        value,
      ).toContain("job condition: no gating job executes @stll/orphan test");
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
      "job condition: package-check/step-1 has unresolved context unresolved condition disjuncts: unresolved condition atom: inputs.RUN_TESTS == true",
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
    ).toContain("job condition: no gating job executes @stll/orphan test");
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
    ).toContain("job condition: no gating job executes @stll/orphan test");
  });

  check(
    "a fallback with an unconditional literal exit keeps the runner gating",
    () => {
      for (const run of [
        "bun scripts/test-gate.ts || { exit 1; }",
        "bun scripts/test-gate.ts || { true; exit 1; }",
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
    },
  );

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
      ).toContain("job condition: no gating job executes @stll/orphan test");
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
    ).toContain("job condition: no gating job executes @stll/orphan test");
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
    ).toContain("job condition: no gating job executes @stll/orphan test");
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
          firstCollectionFailure({ file, scenarios: new Map(), topology }),
        ).toContain(`job condition: no gating job collects ${file}`);
      });
    }
  }

  check.each(["step", "job", "workflow", "cd"] as const)(
    "resolves the %s working directory before collecting Bun paths",
    (scope) => {
      const defaults = { run: { "working-directory": "packages/fixture" } };
      const parsed = {
        ...(scope === "workflow" ? { defaults } : {}),
        jobs: {
          checks: {
            "runs-on": "ubuntu-latest",
            ...(scope === "job" ? { defaults } : {}),
            steps: [
              {
                ...(scope === "step"
                  ? { "working-directory": "packages/fixture" }
                  : {}),
                run:
                  scope === "cd"
                    ? "cd packages/fixture && bun test src"
                    : "bun test src",
              },
            ],
          },
          "ci-result": { needs: ["checks"] },
        },
      };
      const topology = {
        workflow: JSON.stringify(parsed),
        gatingJobs: gatingWorkflowJobs(parsed),
        shardedPackages: new Set<string>(),
      };
      expect(
        firstCollectionFailure({
          file: "packages/fixture/src/selected.test.ts",
          scenarios: new Map(),
          topology,
        }),
      ).toBeUndefined();
      expect(
        firstCollectionFailure({
          file: "src/root.test.ts",
          scenarios: new Map(),
          topology,
        }),
      ).toBeDefined();
      expect(
        firstCollectionFailure({
          file: "scripts/root.test.ts",
          scenarios: new Map(),
          topology,
        }),
      ).toBeDefined();
    },
  );

  check(
    "step directory overrides both defaults and rejects dynamic directories",
    () => {
      const step = {
        "working-directory": "packages/fixture",
        run: "bun test src",
      };
      const workflow = {
        defaults: { run: { "working-directory": "packages/wrong" } },
        jobs: {
          checks: {
            "runs-on": "ubuntu-latest",
            defaults: { run: { "working-directory": "packages/other" } },
            steps: [step],
          },
          "ci-result": { needs: ["checks"] },
        },
      };
      expect(
        gatingWorkflowJobs(workflow).get("checks")?.at(0)?.workingDirectory,
      ).toBe("packages/fixture");
      step["working-directory"] = `\${{ inputs.directory }}`;
      const analysis = analyzeGatingWorkflow(workflow);
      expect(analysis.jobs.has("checks")).toBe(false);
      expect(analysis.findings.join("\n")).toContain(
        "unresolved working-directory",
      );
    },
  );

  check(
    "package scripts collect direct Bun paths after literal directory changes",
    () => {
      const scripts = { test: "cd src && bun test ./selected.test.ts" };
      expect(
        packageTestCollectionFailure({
          candidate: "packages/fixture/src/selected.test.ts",
          packageDirectory: "packages/fixture",
          scripts,
        }),
      ).toBeUndefined();
      expect(
        packageTestCollectionFailure({
          candidate: "packages/fixture/selected.test.ts",
          packageDirectory: "packages/fixture",
          scripts,
        }),
      ).toContain("outside the collector directory");
      expect(
        packageTestCollectionFailure({
          candidate: "packages/fixture/src/selected.test.ts",
          packageDirectory: "packages/fixture",
          scripts: { test: 'cd "$TARGET" && bun test' },
        }),
      ).toContain("shell condition:");
    },
  );

  check.each([
    "cd packages/fixture | cat",
    "printf ready | cd packages/fixture",
  ])("does not infer a parent directory from a pipeline: %s", (prefix) => {
    const parsed = {
      jobs: {
        checks: {
          "runs-on": "ubuntu-latest",
          shell: "bash",
          steps: [{ shell: "bash", run: `${prefix}; bun test src` }],
        },
        "ci-result": { needs: ["checks"] },
      },
    };
    const topology = {
      workflow: JSON.stringify(parsed),
      gatingJobs: gatingWorkflowJobs(parsed),
      shardedPackages: new Set<string>(),
    };
    expect(
      firstCollectionFailure({
        file: "packages/fixture/src/selected.test.ts",
        scenarios: new Map(),
        topology,
      }),
    ).toBeDefined();
    expect(
      firstCollectionFailure({
        file: "scripts/root.test.ts",
        scenarios: new Map(),
        topology,
      }),
    ).toContain("unresolved directory change");
  });

  check(
    "explicit parent paths collect files outside a package without widening implicit filters",
    () => {
      const candidate = "scripts/transfer-read-guard.test.ts";
      for (const selector of [
        "../../scripts/transfer-read-guard.test.ts",
        "scripts",
        "",
      ]) {
        const failure = packageTestCollectionFailure({
          candidate,
          packageDirectory: "packages/scripts",
          scripts: { test: `bun test ${selector}` },
        });
        if (selector.startsWith("../")) {
          expect(failure).toBeUndefined();
        } else {
          expect(failure).toContain("outside the collector directory");
        }
      }
    },
  );

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
        firstCollectionFailure({ file, scenarios: new Map(), topology }),
      ).toBeUndefined();
    }
    const file = ".oxlint-plugins/other/orphan.test.ts";
    expect(
      firstCollectionFailure({ file, scenarios: new Map(), topology }),
    ).toContain(`job condition: no gating job collects ${file}`);
  });

  check("executed scenarios require their exact gating collector", () => {
    const file = "scripts/test-gate.test.ts";
    const command = `bun test ${file}`;
    const scenario: TestScenario = {
      type: "executed",
      file,
      reason: "test-gate regression coverage",
      collector: {
        workflow: ".github/workflows/ci.yml",
        job: "checks",
        command,
      },
    };
    const scenarios = new Map([[file, scenario]]);
    const workflowFor = (run: string, job = "checks", needs = "checks") => {
      const workflow = `jobs:
  ${job}:
    steps:
      - run: ${run}
  ci-result:
    needs: [${needs}]
`;
      return {
        workflow,
        topology: {
          gatingJobs: gatingWorkflowJobs(Bun.YAML.parse(workflow)),
          shardedPackages: new Set<string>(),
          workflow,
        },
      };
    };

    expect(
      firstCollectionFailure({
        file,
        scenarios,
        topology: workflowFor(command).topology,
      }),
    ).toBeUndefined();

    for (const [run, job, reason] of [
      [
        "echo bun test scripts/test-gate.test.ts",
        "checks",
        `ledger collector: no gating invocation of ${command} in checks`,
      ],
      [
        "false && bun test scripts/test-gate.test.ts",
        "checks",
        `ledger collector: no gating invocation of ${command} in checks`,
      ],
      [
        "bun test scripts/other.test.ts",
        "checks",
        `ledger collector: no gating invocation of ${command} in checks`,
      ],
      [
        command,
        "other-checks",
        "ledger collector: checks does not reach ci-result",
      ],
    ] as const) {
      const failure = firstCollectionFailure({
        file,
        scenarios,
        topology: workflowFor(run, job).topology,
      });
      expect(failure, `${job}: ${run}`).toContain(reason);
    }

    const noErrexitWorkflow = `jobs:
  checks:
    steps:
      - shell: bash {0}
        run: |
          ${command}
          echo done
  ci-result:
    needs: [checks]
`;
    expect(
      firstCollectionFailure({
        file,
        scenarios,
        topology: {
          gatingJobs: gatingWorkflowJobs(Bun.YAML.parse(noErrexitWorkflow)),
          shardedPackages: new Set<string>(),
          workflow: noErrexitWorkflow,
        },
      }),
    ).toContain(
      `ledger collector: no gating invocation of ${command} in checks`,
    );

    const removedRunner = workflowFor("echo no test command");
    expect(
      firstCollectionFailure({
        file,
        scenarios,
        topology: removedRunner.topology,
      }),
    ).toContain(
      `ledger collector: no gating invocation of ${command} in checks`,
    );

    const otherFile = "scripts/other.test.ts";
    const otherFileScenario: TestScenario = {
      type: "executed",
      file: otherFile,
      reason: "different named file",
      collector: scenario.collector,
    };
    expect(
      firstCollectionFailure({
        file: otherFile,
        scenarios: new Map([[otherFile, otherFileScenario]]),
        topology: workflowFor(command).topology,
      }),
    ).toContain(`job condition: no gating job collects ${otherFile}`);

    const removedJobWorkflow = `jobs:
  ci-result:
    needs: [checks]
`;
    expect(
      firstCollectionFailure({
        file,
        scenarios,
        topology: {
          gatingJobs: gatingWorkflowJobs(Bun.YAML.parse(removedJobWorkflow)),
          shardedPackages: new Set<string>(),
          workflow: removedJobWorkflow,
        },
      }),
    ).toContain(`ledger collector: checks does not reach ci-result`);
  });

  check("scenario ledger changes cannot add files or weaken coverage", () => {
    const nonGating: TestScenario = {
      type: "non-gating",
      file: "scripts/executed.test.ts",
      owningWorkflow: ".github/workflows/staging-smoke.yml",
      reason: "deployed-environment scenario",
    };
    const executed: TestScenario = {
      type: "executed",
      file: "scripts/executed.test.ts",
      reason: "local regression coverage",
      collector: {
        workflow: ".github/workflows/ci.yml",
        job: "checks",
        command: "bun test scripts/executed.test.ts",
      },
    };
    const pinned: TestScenario = {
      type: "pinned-collector",
      file: "apps/web/e2e/specs/smoke.spec.ts",
      reason: "production browser shard",
      collector: {
        workflow: ".github/workflows/ci.yml",
        job: "e2e-production-shard",
        step: "Run Playwright shard",
        pin: "e2eProductionShards.planSha256",
        condition: "success()",
      },
    };
    const added: TestScenario = {
      type: "executed",
      file: "scripts/new.test.ts",
      reason: "new local regression test",
      collector: {
        workflow: ".github/workflows/ci.yml",
        job: "checks",
        command: "bun test scripts/new.test.ts",
      },
    };

    expect(scenarioLedgerGrowth([nonGating], [nonGating, added])).toEqual([
      "scenario ledger is shrink-only: added scripts/new.test.ts",
    ]);
    expect(scenarioLedgerGrowth([executed], [executed])).toEqual([]);
    expect(scenarioLedgerGrowth([nonGating], [])).toEqual([]);
    expect(scenarioLedgerGrowth([nonGating], [executed])).toEqual([]);

    const executedFromPinned: Extract<TestScenario, { type: "executed" }> = {
      type: "executed",
      file: pinned.file,
      reason: pinned.reason,
      collector: {
        workflow: ".github/workflows/ci.yml",
        job: "checks",
        command: "bun --filter @stll/web test:e2e",
      },
    };
    expect(scenarioLedgerGrowth([pinned], [executedFromPinned])).toEqual([]);

    const executedToNonGating: TestScenario = {
      type: "non-gating",
      file: executed.file,
      owningWorkflow: ".github/workflows/staging-smoke.yml",
      reason: "deployed-environment scenario",
    };
    expect(scenarioLedgerGrowth([executed], [executedToNonGating])).toContain(
      "scenario ledger cannot weaken scripts/executed.test.ts: executed -> non-gating",
    );
    expect(
      scenarioLedgerGrowth(
        [pinned],
        [
          {
            type: "non-gating",
            file: pinned.file,
          },
        ],
      ),
    ).toContain(
      "scenario ledger cannot weaken apps/web/e2e/specs/smoke.spec.ts: pinned-collector -> non-gating",
    );

    const validUpgradeWorkflow = `jobs:
  checks:
    steps:
      - run: bun --filter @stll/web test:e2e
  ci-result:
    needs: [checks]
`;
    expect(
      firstCollectionFailure({
        file: pinned.file,
        scenarios: new Map([[pinned.file, executedFromPinned]]),
        topology: {
          gatingJobs: bashJobs([
            ["checks", ["bun --filter @stll/web test:e2e"]],
          ]),
          shardedPackages: new Set<string>(),
          workflow: validUpgradeWorkflow,
        },
      }),
    ).toBeUndefined();

    const invalidUpgrade: TestScenario = {
      ...executedFromPinned,
      collector: {
        ...executedFromPinned.collector,
        command: "bun test scripts/other.test.ts",
      },
    };
    expect(
      firstCollectionFailure({
        file: pinned.file,
        scenarios: new Map([[pinned.file, invalidUpgrade]]),
        topology: {
          gatingJobs: bashJobs([
            ["checks", ["bun test scripts/other.test.ts"]],
          ]),
          shardedPackages: new Set<string>(),
          workflow: "jobs: {}",
        },
      }),
    ).toBeDefined();
  });

  check("removing a collector cannot downgrade its scenario", () => {
    const previous: TestScenario = {
      type: "executed",
      file: "scripts/removed-collector.test.ts",
      reason: "required root test",
      collector: {
        workflow: ".github/workflows/ci.yml",
        job: "checks",
        command: "bun test scripts/removed-collector.test.ts",
      },
    };
    const current: TestScenario = {
      type: "non-gating",
      file: previous.file,
      owningWorkflow: ".github/workflows/staging-smoke.yml",
      reason: "deployed-environment scenario",
    };
    const removedRunnerWorkflow = `jobs:
  ci-result:
    needs: [checks]
`;

    expect(scenarioLedgerGrowth([previous], [current])).toContain(
      "scenario ledger cannot weaken scripts/removed-collector.test.ts: executed -> non-gating",
    );
    expect(
      firstCollectionFailure({
        file: previous.file,
        scenarios: new Map([[previous.file, current]]),
        topology: {
          gatingJobs: gatingWorkflowJobs(Bun.YAML.parse(removedRunnerWorkflow)),
          shardedPackages: new Set<string>(),
          workflow: removedRunnerWorkflow,
        },
      }),
    ).toBeUndefined();
  });

  check(
    "pins the production Playwright collector to its workflow step",
    () => {
      const workflow = readFileSync(".github/workflows/ci.yml", "utf-8");
      const file = "apps/web/e2e/specs/smoke.spec.ts";
      const scenarios = new Map<string, TestScenario>([
        [
          file,
          {
            type: "pinned-collector",
            file,
            reason: "production browser shard",
            collector: {
              workflow: ".github/workflows/ci.yml",
              job: "e2e-production-shard",
              step: "Run Playwright shard",
              pin: "e2eProductionShards.planSha256",
              condition:
                "steps.e2e-stack.outcome == 'success' && matrix.shard != 'network-baseline'",
            },
          },
        ],
      ]);
      const topologyFor = (source: string) => {
        const parsed = Bun.YAML.parse(source);
        return {
          gatingJobs: gatingWorkflowJobs(parsed),
          shardedPackages: new Set<string>(),
          workflow: source,
        };
      };
      const jobRange = (source: string, jobName: string) => {
        const start = source.indexOf(`  ${jobName}:\n`);
        expect(start, `missing ${jobName} fixture`).toBeGreaterThanOrEqual(0);
        const remainder = source.slice(start + 1);
        const nextJobOffset = remainder.search(/^ {2}[\w-]+:[\t ]*$/mu);
        return {
          start,
          end: nextJobOffset === -1 ? source.length : start + 1 + nextJobOffset,
        };
      };
      const editJob = (
        source: string,
        jobName: string,
        edit: (job: string) => string,
      ) => {
        const { start, end } = jobRange(source, jobName);
        return `${source.slice(0, start)}${edit(source.slice(start, end))}${source.slice(end)}`;
      };
      const failureFor = (source: string) =>
        firstCollectionFailure({
          file,
          scenarios,
          topology: topologyFor(source),
        });

      expect(failureFor(workflow)).toContain("pinned collector:");
      const completeShards = `shard: ${JSON.stringify(allE2eShards())}`;
      const unconditionalWorkflow = editJob(
        workflow.replace(
          `shard: \${{ fromJSON(needs.ci-plan.outputs.e2e_production_matrix).shard }}`,
          () => completeShards,
        ),
        "e2e-production-shard",
        (job) => job,
      );
      expect(unconditionalWorkflow).not.toBe(workflow);
      expect(failureFor(unconditionalWorkflow)).toBeUndefined();

      const mutations: readonly (readonly [
        string,
        (source: string) => string,
      ])[] = [
        [
          "renamed collector step",
          (source) =>
            editJob(source, "e2e-production-shard", (job) =>
              job.replace(
                "- name: Run Playwright shard",
                "- name: Renamed shard",
              ),
            ),
        ],
        [
          "edited collector condition",
          (source) =>
            editJob(source, "e2e-production-shard", (job) =>
              job.replace(
                "        if: >-\n          steps.e2e-stack.outcome == 'success'\n          && matrix.shard != 'network-baseline'",
                "        if: always()",
              ),
            ),
        ],
        [
          "baseline-only collector matrix",
          (source) =>
            editJob(source, "e2e-production-shard", (job) =>
              job.replace(completeShards, () => "shard: [network-baseline]"),
            ),
        ],
        [
          "incomplete production shard matrix",
          (source) =>
            editJob(source, "e2e-production-shard", (job) =>
              job.replace(
                completeShards,
                () => `shard: ${JSON.stringify(allE2eShards().slice(0, -1))}`,
              ),
            ),
        ],
        [
          "changed collector command",
          (source) =>
            editJob(source, "e2e-production-shard", (job) =>
              job.replace(
                '          exit "$status"\n',
                '          exit "$status"\n          echo done\n',
              ),
            ),
        ],
        [
          "collector directory changes",
          (source) =>
            editJob(source, "e2e-production-shard", (job) =>
              job.replace(
                "      - name: Run Playwright shard\n",
                "      - name: Run Playwright shard\n        working-directory: apps/web\n",
              ),
            ),
        ],
        [
          "collector allows errors",
          (source) =>
            editJob(source, "e2e-production-shard", (job) =>
              job.replace(
                "      - name: Run Playwright shard\n",
                "      - name: Run Playwright shard\n        continue-on-error: true\n",
              ),
            ),
        ],
        [
          "collector is disabled",
          (source) =>
            editJob(source, "e2e-production-shard", (job) =>
              job.replace(
                "        if: >-\n          steps.e2e-stack.outcome == 'success'\n          && matrix.shard != 'network-baseline'",
                "        if: false",
              ),
            ),
        ],
        [
          "collector job removed",
          (source) => {
            const { start, end } = jobRange(source, "e2e-production-shard");
            return `${source.slice(0, start)}${source.slice(end)}`;
          },
        ],
        [
          "collector removed from ci-result dependencies",
          (source) => source.replace("        e2e-production-shard,\n", ""),
        ],
      ];
      for (const [reason, mutate] of mutations) {
        const mutated = mutate(unconditionalWorkflow);
        expect(mutated, reason).not.toBe(unconditionalWorkflow);
        expect(failureFor(mutated), reason).toContain("pinned collector:");
      }

      const validScenario = {
        type: "pinned-collector",
        file,
        reason: "production browser shard",
        collector: {
          workflow: ".github/workflows/ci.yml",
          job: "e2e-production-shard",
          step: "Run Playwright shard",
          pin: "e2eProductionShards.planSha256",
          condition: "success()",
        },
      } as const satisfies TestScenario;
      expect(parseScenarioLedger([validScenario])).toEqual([validScenario]);
      expect(() =>
        parseScenarioLedger([
          {
            ...validScenario,
            collector: { ...validScenario.collector, pin: "unknown.pin" },
          },
        ]),
      ).toThrow("structured execution collector");
      expect(() =>
        parseScenarioLedger([{ ...validScenario, collector: undefined }]),
      ).toThrow("structured collector");
    },
    50_000,
  );

  check(
    "nested shell commands retain only their own failure guarantees",
    () => {
      const file = "scripts/named.test.ts";
      const commands: readonly (readonly [string, boolean])[] = [
        ["bash -c 'bun test scripts/named.test.ts; echo done'", false],
        ["bash -c 'bun test scripts/named.test.ts'", true],
        [
          "bash -eo pipefail -c 'bun test scripts/named.test.ts | cat; echo done'",
          true,
        ],
        ["bash -c 'bun test scripts/named.test.ts | cat'", false],
        ["sh -c 'echo setup; bun test scripts/named.test.ts'", true],
        ['bash -c "$COMMAND"', false],
        ["bash -c 'bun test \"$TEST_FILE\"'", false],
        [
          "xargs -I{} bash -c 'bun test scripts/named.test.ts' <<< runner",
          false,
        ],
        ["nice bash -c 'bun test scripts/named.test.ts'", false],
        ["env FOO=bar bash -c 'bun test scripts/named.test.ts'", true],
        [
          "env FOO=bar bash -c 'bun test scripts/named.test.ts; echo done'",
          false,
        ],
        ["timeout 30s bash -c 'bun test scripts/named.test.ts'", true],
        ["timeout 30s bash -c 'bun test scripts/named.test.ts | cat'", false],
      ];
      for (const [command, gates] of commands) {
        const workflow = `jobs:
  root-tests:
    steps:
      - run: |
          ${command}
  ci-result:
    needs: [root-tests]
`;
        const failure = firstCollectionFailure({
          file,
          scenarios: new Map(),
          topology: {
            gatingJobs: gatingWorkflowJobs(Bun.YAML.parse(workflow)),
            shardedPackages: new Set<string>(),
            workflow,
          },
        });
        if (gates) {
          expect(failure, command).toBeUndefined();
        } else {
          expect(failure, command).toContain(
            `job condition: no gating job collects ${file}`,
          );
          expect(failure, command).toContain("shell condition:");
        }
      }
    },
  );

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
          scenarios: new Map(),
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
          scenarios: new Map(),
          topology,
        }),
      ).toContain(`job condition: no gating job collects ${other}`);
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
          scenarios: new Map(),
          topology: {
            gatingJobs: gatingWorkflowJobs(Bun.YAML.parse(workflow)),
            shardedPackages: new Set<string>(),
            workflow,
          },
        }),
      ).toContain(
        "job condition: no gating job collects scripts/named.test.ts",
      );
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
          scenarios: new Map(),
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
              scenarios: new Map(),
              topology: {
                gatingJobs: bashJobs([["root-tests", [command]]]),
                shardedPackages: new Set<string>(),
                workflow,
              },
            }),
          ).toContain(
            "job condition: no gating job collects scripts/named.test.ts",
          );
        },
      );
    }
    check(`rejects a package script body ${shape}`, () => {
      expect(
        packageTestExecutionFailure({
          gatingJobs: bashJobs([
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
        ).toContain(
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
          gatingJobs: bashJobs([["browser-tests", [invocation]]]),
          shardedPackages: new Set<string>(),
          workflow: invocation,
        },
      }),
    ).toEqual({ type: "not-collected" });
  });
});

context("extension browser spec collection", () => {
  check("collects extension bridge specs through the actual config", () => {
    const file = "apps/extension/e2e/bridge.spec.ts";
    const workflow = `jobs:
  extension-e2e:
    steps:
      - run: bun --filter @stll/extension test:e2e
  ci-result:
    needs: [extension-e2e]
`;
    expect(
      firstCollectionFailure({
        file,
        scenarios: new Map(),
        topology: {
          gatingJobs: bashJobs([
            ["extension-e2e", ["bun --filter @stll/extension test:e2e"]],
          ]),
          shardedPackages: new Set<string>(),
          workflow,
        },
      }),
    ).toBeUndefined();
  });
});

context("result aggregation dependency ownership", () => {
  const workflowWithNeeds = (needs: string) =>
    Bun.YAML.parse(`jobs:
  ci-tests:
    runs-on: ubuntu-latest
    steps:
      - run: bun test fixture.test.ts
  ci-result:
    needs: ${needs}
    steps: []
`);

  check.each([
    "[ci-tests, other-job]",
    "[other-job, ci-tests]",
    "[other-job, ci-tests,]",
    "\n      - other-job\n      - ci-tests",
    "ci-tests",
    '"ci-tests"',
  ])("exact dependencies survive YAML formatting: %s", (needs) => {
    const workflow: unknown = workflowWithNeeds(needs);
    expect(
      resultAggregationFailures({ workflow, collectors: ["ci-tests"] }),
    ).toEqual([]);
    expect(analyzeGatingWorkflow(workflow, []).jobs.has("ci-tests")).toBe(true);
  });

  check.each([
    "[other-ci-tests, other-job]",
    "[ci-tests-shadow, other-job]",
    "[other-job]",
    "[]",
    "42",
    "\n      - other-job",
  ])("substrings cannot supply exact dependencies: %s", (needs) => {
    const workflow: unknown = workflowWithNeeds(needs);
    expect(
      resultAggregationFailures({ workflow, collectors: ["ci-tests"] }),
    ).toEqual(["result aggregation: ci-result does not consume ci-tests"]);
    expect(analyzeGatingWorkflow(workflow, []).jobs.has("ci-tests")).toBe(
      false,
    );
  });

  check("text in later jobs cannot supply a result dependency", () => {
    const workflow: unknown = Bun.YAML.parse(`jobs:
  ci-tests:
    runs-on: ubuntu-latest
    steps:
      - run: bun test fixture.test.ts
  ci-result:
    needs: [other-job]
    steps: []
  later-job:
    env:
      UNRELATED_TEXT: "ci-tests,"
    steps: []
`);
    expect(
      resultAggregationFailures({ workflow, collectors: ["ci-tests"] }),
    ).toEqual(["result aggregation: ci-result does not consume ci-tests"]);
    expect(analyzeGatingWorkflow(workflow, []).jobs.has("ci-tests")).toBe(
      false,
    );
  });

  check("a similarly named job cannot replace the result owner", () => {
    const workflow: unknown = Bun.YAML.parse(`jobs:
  ci-result-copy:
    needs: [ci-tests]
    steps: []
`);
    expect(
      resultAggregationFailures({ workflow, collectors: ["ci-tests"] }),
    ).toEqual(["result aggregation: ci-result job is missing"]);
  });
});

context("repository execution topology validation", () => {
  check(
    "returns real workflow findings without relying on the CLI accumulator",
    () => {
      const topology = repositoryTestExecutionTopology();
      expect(topology.findings).toEqual([]);
      expect(topology.gatingJobs.size).toBeGreaterThan(0);
      expect(
        firstCollectionFailure({
          file: "scripts/test-gate.test.ts",
          scenarios: new Map(),
        }),
      ).toBeUndefined();
      expect(repositoryTestExecutionTopology()).toBe(topology);
    },
  );
});

context("real marketing Playwright factory composition", () => {
  check.each([
    "apps/landing/e2e/landing-anonymize-demo.spec.ts",
    "apps/landing/e2e/landing-navigation.spec.ts",
  ])("collects %s through the real CI topology", (file) => {
    expect(
      firstCollectionFailure({ file, scenarios: new Map() }),
    ).toBeUndefined();
  });

  check("retains the real collaboration config layer composition", () => {
    const command = "bun --filter @stll/web test:browser";
    expect(
      gatingPlaywrightCollection({
        file: "apps/web/e2e/collab/folio-collaboration.spec.ts",
        packageFile: "apps/web/package.json",
        scripts: {
          "test:browser":
            "playwright test --config e2e/playwright.collab.config.ts",
        },
        topology: {
          gatingJobs: bashJobs([["browser", [command]]]),
          workflow: command,
          shardedPackages: new Set<string>(),
        },
      }),
    ).toEqual({ type: "collected" });
  });

  check(
    "collects the real marketing screenshot spec through its package manifest",
    () => {
      const packageFile = "apps/web/package.json";
      const packageManifest = Bun.YAML.parse(
        readFileSync(packageFile, "utf-8"),
      );
      if (
        typeof packageManifest !== "object" ||
        packageManifest === null ||
        !("scripts" in packageManifest) ||
        typeof packageManifest.scripts !== "object" ||
        packageManifest.scripts === null ||
        !("test:e2e:marketing" in packageManifest.scripts) ||
        typeof packageManifest.scripts["test:e2e:marketing"] !== "string"
      ) {
        throw new Error("web marketing Playwright script is missing");
      }
      const scripts = {
        "test:e2e:marketing": packageManifest.scripts["test:e2e:marketing"],
      };
      const invocation = "bun --filter @stll/web test:e2e:marketing";
      const workflow = `jobs:
  marketing:
    steps:
      - run: ${invocation}
  ci-result:
    needs: [marketing]
`;

      expect(
        gatingPlaywrightCollection({
          file: "apps/web/e2e/marketing/product-screenshots.spec.ts",
          packageFile,
          scripts,
          topology: {
            gatingJobs: bashJobs([["marketing", [invocation]]]),
            shardedPackages: new Set<string>(),
            workflow,
          },
        }),
      ).toEqual({ type: "collected" });
    },
  );
});

context("Playwright configuration filters", () => {
  const collectsFrom = (
    source: string,
    name = "theme-prepaint.playwright.spec.ts",
  ) =>
    gatingPlaywrightCollection({
      file: `apps/desktop/tests/browser/${name}`,
      packageFile: "apps/desktop/package.json",
      scripts: { "test:browser": "playwright test" },
      topology: {
        gatingJobs: bashJobs([
          ["browser-tests", ["bun --filter @stll/desktop test:browser"]],
        ]),
        shardedPackages: new Set<string>(),
        workflow: "",
      },
      readConfig: () => source,
    });

  const collects = (
    filter: string,
    name = "theme-prepaint.playwright.spec.ts",
  ) =>
    gatingPlaywrightCollection({
      file: `apps/desktop/tests/browser/${name}`,
      packageFile: "apps/desktop/package.json",
      scripts: { "test:browser": "playwright test" },
      topology: {
        gatingJobs: bashJobs([
          ["browser-tests", ["bun --filter @stll/desktop test:browser"]],
        ]),
        shardedPackages: new Set<string>(),
        workflow: "",
      },
      readConfig: () =>
        `import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./tests/browser", ${filter} });`,
    });
  check.each([
    'ignored.push("**/*.spec.ts")',
    'ignored[0] = "**/*.spec.ts"',
    "mutate(ignored)",
    "const escaped = [...ignored]",
    "export { ignored }",
  ])("rejects mutable or escaping literal configuration values: %s", (use) => {
    expect(
      collectsFrom(`import { defineConfig } from "@playwright/test";
const ignored = [];
${use};
export default defineConfig({ testDir: "./tests/browser", testIgnore: ignored });`),
    ).toMatchObject({
      type: "unresolved",
      finding: expect.stringContaining(
        "mutable or escaping configuration value ignored",
      ),
    });
  });

  check("clean literal constants are direct config reads", () => {
    expect(
      collectsFrom(`import { defineConfig } from "@playwright/test";
const ignored = [];
const pattern = /theme-prepaint\\.playwright\\.spec\\.ts$/u;
export default defineConfig({ testDir: "./tests/browser", testIgnore: ignored, testMatch: [pattern] });`),
    ).toEqual({ type: "collected" });
  });

  const collectsImported = ({
    importer,
    exporter,
  }: {
    importer: string;
    exporter: string;
  }) =>
    gatingPlaywrightCollection({
      file: "apps/desktop/tests/browser/theme-prepaint.playwright.spec.ts",
      packageFile: "apps/desktop/package.json",
      scripts: { "test:browser": "playwright test" },
      topology: {
        gatingJobs: bashJobs([
          ["browser-tests", ["bun --filter @stll/desktop test:browser"]],
        ]),
        shardedPackages: new Set<string>(),
        workflow: "",
      },
      readConfig: (file) =>
        file.endsWith("apps/web/e2e/playwright.config.ts")
          ? exporter
          : importer,
    });
  const importedLayer = `import { defineConfig } from "@playwright/test";
import base from "../web/e2e/playwright.config";
export default defineConfig(base, {});`;
  const exportedLayer = `export const ignored = [];
export default { testDir: "./tests/browser", testIgnore: ignored };`;

  check("recursively credits an immutable exported layer", () => {
    expect(
      collectsImported({ importer: importedLayer, exporter: exportedLayer }),
    ).toEqual({ type: "collected" });
  });
  check("a mutated imported array cannot grant collection credit", () => {
    expect(
      collectsImported({
        importer: importedLayer,
        exporter: exportedLayer.replace(
          "export default",
          'ignored.push("**/*.spec.ts"); export default',
        ),
      }),
    ).toMatchObject({
      type: "unresolved",
      finding: expect.stringContaining(
        "mutable or escaping configuration value ignored",
      ),
    });
  });
  check.each(['base.testIgnore.push("**/*.spec.ts")', "mutate(base)"])(
    "rejects an imported layer escape: %s",
    (use) => {
      expect(
        collectsImported({
          importer: importedLayer.replace(
            "export default",
            () => `${use}; export default`,
          ),
          exporter: exportedLayer,
        }),
      ).toMatchObject({
        type: "unresolved",
        finding: expect.stringContaining("mutable or escaping imported layer"),
      });
    },
  );
  check("a sibling import cannot mutate a resolved layer value", () => {
    expect(
      collectsImported({
        importer: importedLayer
          .replace("import base from", "import base, { ignored } from")
          .replace(
            "export default",
            'ignored.push("**/*.spec.ts"); export default',
          ),
        exporter: exportedLayer,
      }),
    ).toMatchObject({
      type: "unresolved",
      finding: expect.stringContaining("mutable or escaping exports"),
    });
  });
  check("named const exports are immutable layers", () => {
    expect(
      collectsImported({
        importer: importedLayer.replace(
          "import base from",
          "import { base } from",
        ),
        exporter:
          'export const base = { testDir: "./tests/browser", testIgnore: [] };',
      }),
    ).toEqual({ type: "collected" });
  });

  check("later filter arrays replace previous values", () => {
    expect(
      collectsFrom(`import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./tests/browser", testIgnore: ["**/*.spec.ts"] }, { testIgnore: [] });`),
    ).toEqual({ type: "collected" });
  });
  check(
    "project layers retain other names and override matching fields",
    () => {
      expect(
        collectsFrom(`import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./tests/browser", projects: [{ name: "main", testMatch: ["**/theme-prepaint.playwright.spec.ts"] }] }, { projects: [{ name: "extra", testIgnore: ["**/*.spec.ts"] }] });`),
      ).toEqual({ type: "collected" });
      expect(
        collectsFrom(`import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./tests/browser", projects: [{ name: "main", testIgnore: ["**/*.spec.ts"] }] }, { projects: [{ name: "main", testIgnore: [] }] });`),
      ).toEqual({ type: "collected" });
      expect(
        collectsFrom(`import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./tests/browser", projects: [{ name: "main", testIgnore: ["**/*.spec.ts"] }] }, { projects: [{ name: "main" }] });`),
      ).toEqual({ type: "not-collected" });
    },
  );

  check("an array testIgnore excludes a file", () => {
    expect(
      collects('testIgnore: ["**/theme-prepaint.playwright.spec.ts"]'),
    ).toEqual({ type: "not-collected" });
  });
  check("proves config factories from their Playwright import", () => {
    const objectConfig = `export default { testDir: "./tests/browser" };`;
    const namedAlias = `import { defineConfig as configure } from "@playwright/test";\nexport default configure({ testDir: "./tests/browser" });`;
    const namespace = `import * as playwright from "@playwright/test";\nexport default playwright.defineConfig({ testDir: "./tests/browser" });`;
    expect(collectsFrom(objectConfig)).toEqual({ type: "collected" });
    expect(collectsFrom(namedAlias)).toEqual({ type: "collected" });
    expect(collectsFrom(namespace)).toEqual({ type: "collected" });
  });

  check("an unknown factory cannot hide testIgnore", () => {
    expect(
      collectsFrom(
        `export default withDefaults({ testDir: "./tests/browser", testIgnore: ["**/*.spec.ts"] });`,
      ),
    ).toEqual({
      type: "unresolved",
      finding:
        "runner config: apps/desktop/playwright.config.ts has unresolved exported factory (expected an immutable @playwright/test defineConfig import)",
    });
  });

  check.each([
    [
      "factory imported from another module",
      `import { defineConfig } from "@stll/config-tools";\nexport default defineConfig({ testDir: "./tests/browser" });`,
    ],
    [
      "reassigned named import",
      `import { defineConfig } from "@playwright/test";\ndefineConfig = unknownFactory;\nexport default defineConfig({ testDir: "./tests/browser" });`,
    ],
    [
      "reassigned namespace import",
      `import * as playwright from "@playwright/test";\nplaywright = unknownFactory;\nexport default playwright.defineConfig({ testDir: "./tests/browser" });`,
    ],
  ])("does not prove untrusted config construction: %s", (_name, source) => {
    expect(collectsFrom(source)).toMatchObject({ type: "unresolved" });
  });
  check("does not expand a nonliteral config spread", () => {
    expect(
      collectsFrom(
        `const inherited = readConfig();\nexport default { ...inherited, testDir: "./tests/browser" };`,
      ),
    ).toMatchObject({
      type: "unresolved",
      finding: expect.stringContaining("config"),
    });
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
  check("resolves workflow and package-script Playwright directories", () => {
    const workflow = {
      jobs: {
        browser: {
          "runs-on": "ubuntu-latest",
          steps: [
            {
              "working-directory": "apps/desktop",
              run: "bun run test:browser",
            },
          ],
        },
        "ci-result": { needs: ["browser"] },
      },
    };
    const collection = gatingPlaywrightCollection({
      file: "apps/desktop/tests/browser/one.spec.ts",
      packageFile: "apps/desktop/package.json",
      scripts: {
        "test:browser":
          "cd tests/browser && playwright test --config ../../playwright.config.ts",
      },
      topology: {
        workflow: JSON.stringify(workflow),
        gatingJobs: gatingWorkflowJobs(workflow),
        shardedPackages: new Set<string>(),
      },
      readConfig: () =>
        'import { defineConfig } from "@playwright/test"; export default defineConfig({testDir:"./tests/browser",testMatch:"**/one.spec.ts"});',
    });
    expect(collection).toEqual({ type: "collected" });
    expect(
      packageTestExecutionFailure({
        packageDirectory: "apps/desktop",
        packageName: "@stll/desktop",
        scriptName: "test:browser",
        shardedPackages: new Set<string>(),
        gatingJobs: new Map([
          [
            "browser",
            [
              {
                command: "bun run test:browser",
                workingDirectory: "apps/extension",
                environment: {},
                propagation: { errexit: true, pipefail: false },
              },
            ],
          ],
        ]),
      }),
    ).toBeDefined();
  });

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
            gatingJobs: bashJobs([["browser-tests", [invocation]]]),
            shardedPackages: new Set<string>(),
            workflow: invocation,
          },
          readConfig: () => `import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./tests/browser", projects: [
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
        gatingJobs: bashJobs([["browser-tests", [invocation]]]),
        shardedPackages: new Set<string>(),
        workflow: invocation,
      },
      readConfig: () => `import { defineConfig } from "@playwright/test";
      export default defineConfig({
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
        'import { defineConfig } from "@playwright/test"; export default defineConfig({ testDir: "./tests/browser" });',
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
