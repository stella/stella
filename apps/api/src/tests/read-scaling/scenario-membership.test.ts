import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  readScenarioRegistry,
  scenarioMembershipViolations,
} from "./scenario-membership";
import {
  parseScalingLedger,
  scalingCoverageViolations,
  withNewWriteRoutes,
} from "./surface";

const entryFile = "apps/api/src/tests/read-scaling/fixture.ts";
const owner = {
  file: "apps/api/src/handlers/rows/list.ts",
  exportName: "default",
};
const apiEntry = `{ name: "rows", handler: rows.handler, measure: measureRows }`;
const apiSource = `import rows from "@/api/handlers/rows/list"; const scenarios = [${apiEntry}];`;

/** Every handler module is still in the tree. */
const kept = () => true;

const readApi = (
  source: string,
  extraSources: ReadonlyMap<string, string> = new Map(),
) =>
  readScenarioRegistry({
    kind: "api",
    file: entryFile,
    symbol: "scenarios",
    readSource: (file) => {
      if (file === entryFile) {
        return source;
      }
      const extra = extraSources.get(file);
      return extra ?? panic(`Missing fixture source ${file}`);
    },
  });

describe("measured scaling scenario membership", () => {
  test("a scenario naming the endpoint definition keeps the owner of the handler it replaced", () => {
    const current = readApi(
      apiSource.replace("handler: rows.handler", "definition: rows"),
    );
    expect(current).toEqual([
      { kind: "api", name: "rows", handlerOwner: owner },
    ]);
    expect(
      scenarioMembershipViolations({
        base: readApi(apiSource),
        current,
        handlerExists: kept,
      }),
    ).toEqual([]);
  });

  test("a reasoned pending POST cannot replace an existing measured scenario", () => {
    const id = "POST /v1/rows";
    const ledger = {
      unmeasuredReads: [],
      pendingWriteHarness: [{ id, reason: "Awaiting a write fixture" }],
    };
    const entries = parseScalingLedger(JSON.stringify(ledger), "fixture");
    // This reaches the original allowance and coverage loophole.
    expect(
      withNewWriteRoutes({ base: [], current: entries, writes: [id] }),
    ).toEqual(entries);
    expect(
      scalingCoverageViolations({
        surface: [id],
        measured: [],
        exemptions: ledger.pendingWriteHarness,
      }),
    ).toEqual([]);
    expect(
      scenarioMembershipViolations({
        base: readApi(apiSource),
        current: readApi("const scenarios = [];"),
        handlerExists: kept,
      }),
    ).toEqual([
      `previously measured scenario removed: ${JSON.stringify(["api", "rows", owner.file, owner.exportName])}`,
    ]);
  });

  test("a scenario leaves only with its handler: a route deleted whole has nothing to measure", () => {
    const current = readApi("const scenarios = [];");
    const removed = `previously measured scenario removed: ${JSON.stringify(["api", "rows", owner.file, owner.exportName])}`;
    // Its handler still in the tree: the route stays, so its scenario does.
    expect(
      scenarioMembershipViolations({
        base: readApi(apiSource),
        current,
        handlerExists: (file) => file === owner.file,
      }),
    ).toEqual([removed]);
    // Deleted with its handler module: nothing is left to measure.
    expect(
      scenarioMembershipViolations({
        base: readApi(apiSource),
        current,
        handlerExists: (file) => file !== owner.file,
      }),
    ).toEqual([]);
  });

  test("a handler that moved keeps every case it had, even with its old module gone", () => {
    const moved = apiSource.replace(
      "handlers/rows/list",
      "handlers/rows/archive",
    );
    const base = readApi(
      apiSource.replace(
        apiEntry,
        () => `${apiEntry}, ${apiEntry.replace('"rows"', '"filtered rows"')}`,
      ),
    );
    expect(base).toHaveLength(2);
    // Only "rows" survives, under the new module; the old one is gone.
    const violations = scenarioMembershipViolations({
      base,
      current: readApi(moved),
      handlerExists: (file) => file !== owner.file,
    });
    expect(violations).toContain(
      `previously measured scenario removed: ${JSON.stringify(["api", "filtered rows", owner.file, owner.exportName])}`,
    );
  });

  test("retargeting a scenario name to a different handler owner is refused", () => {
    const current = readApi(
      apiSource.replace("handlers/rows/list", "handlers/rows/archive"),
    );
    expect(current).not.toEqual(readApi(apiSource));
    expect(
      scenarioMembershipViolations({
        base: readApi(apiSource),
        current,
        handlerExists: kept,
      }),
    ).toHaveLength(1);
  });

  test("one measured case cannot replace another case of the same handler", () => {
    const base = readApi(
      apiSource.replace(
        apiEntry,
        () => `${apiEntry}, ${apiEntry.replace('"rows"', '"filtered rows"')}`,
      ),
    );
    expect(base).toHaveLength(2);
    expect(
      scenarioMembershipViolations({
        base,
        current: readApi(apiSource),
        handlerExists: kept,
      }),
    ).toEqual([
      `previously measured scenario removed: ${JSON.stringify(["api", "filtered rows", owner.file, owner.exportName])}`,
    ]);
  });

  test("a genuine new write may enter with a reason while prior measurements remain", () => {
    const id = "POST /v1/new-rows";
    const entries = parseScalingLedger(
      JSON.stringify({
        unmeasuredReads: [],
        pendingWriteHarness: [
          { id, reason: "Awaiting its bounded write fixture" },
        ],
      }),
      "fixture",
    );
    expect(
      withNewWriteRoutes({ base: [], current: entries, writes: [id] }),
    ).toEqual(entries);
    expect(
      scenarioMembershipViolations({
        base: readApi(apiSource),
        current: readApi(apiSource),
        handlerExists: kept,
      }),
    ).toEqual([]);
  });

  test("scaling scenario import aliases preserve membership", () => {
    assertProperty(
      "scaling scenario import aliases preserve membership",
      fc.property(fc.integer({ min: 0, max: 100_000 }), (suffix) => {
        const alias = `handler${suffix}`;
        const current = readApi(
          apiSource
            .replaceAll("rows.handler", () => `${alias}.handler`)
            .replace("import rows ", () => `import ${alias} `),
        );
        expect(current).toEqual([
          { kind: "api", name: "rows", handlerOwner: owner },
        ]);
        expect(
          scenarioMembershipViolations({
            base: readApi(apiSource),
            current,
            handlerExists: kept,
          }),
        ).toEqual([]);
      }),
    );
  });

  test("imported const arrays, alias exports and local consts retain their owners", () => {
    const sources = new Map([
      [
        "apps/api/src/tests/read-scaling/shared.ts",
        `import { readRows as rows } from "../../handlers/rows/list"; export const shared = [${apiEntry}];`,
      ],
    ]);
    expect(
      readApi(
        'import { shared as imported } from "./shared"; const alias = imported; const scenarios = [...alias];',
        sources,
      ),
    ).toEqual([
      {
        kind: "api",
        name: "rows",
        handlerOwner: {
          file: "apps/api/src/handlers/rows/list.ts",
          exportName: "readRows",
        },
      },
    ]);
  });

  test("MCP membership uses the actual literal tool name", () => {
    const read = (source: string) =>
      readScenarioRegistry({
        kind: "mcp",
        file: entryFile,
        symbol: "scenarios",
        readSource: () => source,
      });
    const base = read(
      'const scenarios = [{ name: "list_rows" satisfies ToolName, measure: measureRows }];',
    );
    expect(base).toEqual([{ kind: "mcp", name: "list_rows" }]);
    expect(
      scenarioMembershipViolations({
        base,
        current: read("const scenarios = [];"),
        // A tool's measurement stays whatever its handler.
        handlerExists: () => false,
      }),
    ).toEqual(['previously measured scenario removed: ["mcp","list_rows"]']);
  });

  test.each([
    [
      "dynamic registry",
      "const scenarios = makeScenarios();",
      "scenario must be a literal",
    ],
    ["mutable registry", "let scenarios = [];", "missing immutable binding"],
    [
      "cycle",
      "const scenarios = alias; const alias = scenarios;",
      "cyclic binding",
    ],
    [
      "type-only owner",
      `import type rows from "@/api/handlers/rows/list"; const scenarios = [${apiEntry}];`,
      "handler must name an imported owner",
    ],
    [
      "spread override",
      `import rows from "@/api/handlers/rows/list"; const scenarios = [{ ...other, ${apiEntry.slice(1, -1)} }];`,
      "computed, spread or accessor",
    ],
    [
      "computed field",
      `import rows from "@/api/handlers/rows/list"; const scenarios = [{ ["name"]: "rows", handler: rows.handler, measure: measureRows }];`,
      "computed, spread or accessor",
    ],
    [
      "duplicate names",
      apiSource.replace(apiEntry, () => `${apiEntry}, ${apiEntry}`),
      "duplicate scenario names",
    ],
    [
      "unknown owner",
      `const scenarios = [${apiEntry}];`,
      "handler must name an imported owner",
    ],
    [
      "missing registry module",
      'import { missing } from "./missing"; const scenarios = missing;',
      "Missing fixture source",
    ],
  ])("%s fails closed", (_label, source, message) => {
    expect(() => readApi(source)).toThrow(message);
  });
});
