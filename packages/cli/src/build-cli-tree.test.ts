import type { Application, Command } from "@stricli/core";
import { describe, expect, test } from "bun:test";

import { buildApp, buildFlag } from "./build-cli-tree.js";
import type { Context } from "./context.js";
import { projectDeploymentCommands } from "./deployment-command-projection.js";
import { flagKey } from "./flag-name.js";
import { generatedRouteMap } from "./generated/route-map.js";
import { RESERVED_FLAG_KEYS } from "./reserved-flag-keys.js";
import type { FlagSpec, RouteNode } from "./route-types.js";

const flagSpec = (overrides: Partial<FlagSpec>): FlagSpec => ({
  flag: "example",
  prop: "example",
  kind: "string",
  required: false,
  repeatable: false,
  ...overrides,
});

// Every generated value flag must be optional at the stricli layer: a field can
// always be supplied via --input, and required-ness is enforced after the
// --input/flag merge against the JSON schema. A *required* stricli flag rejects
// the whole command when the field is omitted — the bug that made optional array
// flags like --assignee-ids unusable when left off. This pins the class so no
// flag kind (present or future) can regress into requiring a value.
describe("buildFlag optionality invariant", () => {
  const cases: FlagSpec[] = [
    flagSpec({ kind: "string", required: false }),
    flagSpec({ kind: "string", required: true }),
    flagSpec({ kind: "int", required: true, min: 0, max: 10 }),
    flagSpec({ kind: "enum", required: true, enum: ["a", "b"] }),
    flagSpec({ kind: "boolean", required: false }),
    // The regression case: an optional repeatable array field.
    flagSpec({ kind: "string-array", required: false, repeatable: true }),
    // Even a required array is optional at the stricli layer.
    flagSpec({ kind: "int-array", required: true, repeatable: true }),
  ];

  test("every generated value flag is optional", () => {
    for (const spec of cases) {
      expect(buildFlag(spec).optional).toBe(true);
    }
  });

  test("repeatable fields become variadic, non-repeatable do not", () => {
    const variadic = buildFlag(
      flagSpec({ kind: "string-array", repeatable: true }),
    ) as Record<string, unknown>;
    expect(variadic).toMatchObject({ kind: "parsed", variadic: true });

    const scalar = buildFlag(flagSpec({ kind: "string" })) as Record<
      string,
      unknown
    >;
    expect(scalar["variadic"]).toBeUndefined();
  });

  test("boolean fields build a boolean flag", () => {
    const boolean = buildFlag(flagSpec({ kind: "boolean" })) as Record<
      string,
      unknown
    >;
    expect(boolean).toMatchObject({ kind: "boolean", optional: true });
  });
});

const generatedFlags = (node: RouteNode): FlagSpec[] => {
  if (node.kind === "leaf" || node.kind === "capability-leaf") {
    return [...node.spec.flags];
  }
  return Object.values(node.children).flatMap(generatedFlags);
};

describe("flag help facts", () => {
  const briefOf = (spec: FlagSpec): unknown =>
    (buildFlag(spec) as Record<string, unknown>)["brief"];

  test("facts read as one clause, never as a nested bracket", () => {
    expect(
      briefOf(flagSpec({ description: "Document entity ID", required: true })),
    ).toBe("Document entity ID (required, string)");
    expect(briefOf(flagSpec({ kind: "enum", enum: ["a", "b"] }))).toBe(
      "(optional, enum: a, b)",
    );
    expect(
      briefOf(flagSpec({ kind: "int", min: 1, max: 100, repeatable: true })),
    ).toBe("(optional, int 1..100, repeatable)");
  });
});

/**
 * `--server` is a global concern, so it must exist on EVERY command the CLI
 * dispatches: generated tool leaves, capability leaves, resource leaves, and
 * the hand-written commands alike. Walking the assembled route tree is what
 * keeps a new command surface from silently rejecting `--server` again.
 */
describe("every command accepts --server", () => {
  type Target = Application<Context>["root"];

  // stricli's `kind` discriminators are non-exported unique symbols, so a
  // routing target is narrowed by the accessor only a route map has.
  const isRouteMap = (
    target: Target,
  ): target is Exclude<Target, Command<Context>> => "getAllEntries" in target;

  const missingServerFlag = (
    target: Target,
    path: readonly string[],
  ): readonly string[] => {
    if (!isRouteMap(target)) {
      return target.usesFlag(RESERVED_FLAG_KEYS.server, "allow-kebab-for-camel")
        ? []
        : [path.join(" ")];
    }
    return target
      .getAllEntries()
      .flatMap((entry) =>
        missingServerFlag(entry.target, [...path, entry.name.original]),
      );
  };

  test("no leaf of the assembled tree is missing it", () => {
    expect(missingServerFlag(buildApp(generatedRouteMap).root, [])).toEqual([]);
  });
});

describe("generated flag parser conformance", () => {
  test("every generated long flag has a Stricli-supported key", () => {
    for (const spec of generatedFlags(generatedRouteMap)) {
      // Stricli reserves one-character names for aliases. Its long-flag scanner
      // requires a letter followed by at least one supported character.
      expect(flagKey(spec)).toMatch(/^[a-z][a-zA-Z0-9]+$/u);
    }
  });
});

describe("buildApp: deployment command projection", () => {
  type Target = Application<Context>["root"];
  const isRouteMap = (
    target: Target,
  ): target is Exclude<Target, Command<Context>> => "getAllEntries" in target;

  /** `path -> brief` for every command and group in the assembled tree. */
  const briefs = (
    target: Target,
    path: readonly string[],
  ): [string, string][] =>
    isRouteMap(target)
      ? [
          [path.join(" "), target.brief],
          ...target
            .getAllEntries()
            .flatMap((entry) =>
              briefs(entry.target, [...path, entry.name.original]),
            ),
        ]
      : [[path.join(" "), target.brief]];

  const briefsFor = (
    attestation: Omit<Parameters<typeof projectDeploymentCommands>[0], "tree">,
  ) =>
    new Map(
      briefs(
        buildApp(
          projectDeploymentCommands({
            tree: generatedRouteMap,
            ...attestation,
          }),
        ).root,
        [],
      ),
    );

  const capabilityIdsUnder = (domain: string): string[] => {
    const capability =
      generatedRouteMap.kind === "route"
        ? generatedRouteMap.children["capability"]
        : undefined;
    const group =
      capability?.kind === "route" ? capability.children[domain] : undefined;
    return group?.kind === "route"
      ? Object.values(group.children).flatMap((child) =>
          child.kind === "capability-leaf" ? [child.spec.capabilityId] : [],
        )
      : [];
  };

  const assertNoDisabledMarker = (projected: ReadonlyMap<string, string>) => {
    expect(
      [...projected.values()].some((brief) =>
        brief.includes("disabled on this server"),
      ),
    ).toBe(false);
  };

  test("an explicitly refused tool is absent from the assembled tree while siblings remain", () => {
    const projected = briefsFor({
      featureOmittedTools: ["list_matters"],
      featureOmittedCapabilities: [],
    });
    expect(projected.has("matter list")).toBe(false);
    expect(projected.has("matter save")).toBe(true);
    expect(projected.has("matter")).toBe(true);
    assertNoDisabledMarker(projected);
  });

  test("an explicitly refused capability is absent independently of a same-named tool", () => {
    const projected = briefsFor({
      featureOmittedTools: [],
      featureOmittedCapabilities: ["usage.entitlement.get"],
    });
    expect(projected.has("capability usage entitlement-get")).toBe(false);
    expect(projected.has("usage get")).toBe(true);
    assertNoDisabledMarker(projected);
  });

  test("partly refused groups retain eligible children and clean briefs", () => {
    const projected = briefsFor({
      featureOmittedTools: ["list_matters"],
      featureOmittedCapabilities: ["time-entries.csv.export"],
    });
    expect(projected.has("matter list")).toBe(false);
    expect(projected.has("matter save")).toBe(true);
    expect(projected.has("capability time-entries csv-export")).toBe(false);
    expect(projected.has("capability time-entries")).toBe(true);
    expect(projected.has("capability time-entries list")).toBe(true);
    assertNoDisabledMarker(projected);
  });

  test("fully refused generated groups disappear without removing sibling groups", () => {
    const usageIds = capabilityIdsUnder("usage");
    expect(usageIds.length).toBeGreaterThan(0);
    const projected = briefsFor({
      featureOmittedTools: ["get_usage"],
      featureOmittedCapabilities: usageIds,
    });
    expect(projected.has("usage")).toBe(false);
    expect(projected.has("capability usage")).toBe(false);
    expect(projected.has("capability")).toBe(true);
    expect(projected.has("matter list")).toBe(true);
    expect(projected.has("capability time-entries list")).toBe(true);
    assertNoDisabledMarker(projected);
  });

  test("explicit empty omissions preserve all generated command paths without markers", () => {
    const projected = briefsFor({
      featureOmittedTools: [],
      featureOmittedCapabilities: [],
    });
    const all = new Map(briefs(buildApp(generatedRouteMap).root, []));
    expect([...projected.keys()]).toEqual([...all.keys()]);
    assertNoDisabledMarker(projected);
  });
});
