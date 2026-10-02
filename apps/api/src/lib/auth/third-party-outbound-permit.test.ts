import { describe, expect, test } from "bun:test";
import path from "node:path";

import { isRecord } from "@/api/lib/type-guards";

// A third-party outbound permit is the only way to reach a third-party
// client, and the chat script runner never holds one. Two guards keep that
// true: permits are granted only at the direct call boundaries listed here,
// and the packages' network calls are imported only by the API modules that
// take a permit for them.

const API_SRC = path.resolve(import.meta.dir, "../..");

/** The API's production sources, by path relative to `src`. */
const productionSources = async (): Promise<Map<string, string>> => {
  const sources = new Map<string, string>();
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: API_SRC })) {
    if (file.endsWith(".test.ts") || file.startsWith("tests/")) {
      continue;
    }
    sources.set(file, await Bun.file(path.join(API_SRC, file)).text());
  }
  return sources;
};

/**
 * Where a permit may be granted: a direct call boundary (an HTTP route or its
 * logic, a native chat tool, the MCP transport, a user-requested export job).
 * Never an MCP tool handler or anything a chat script reaches: those receive
 * the permit their boundary holds. Adding a file here is a security decision.
 */
const PERMIT_GRANTING_SOURCES = [
  "handlers/case-law/public-routes.ts",
  "handlers/chat/tools/boe-tools.ts",
  "handlers/chat/tools/business-registry-tools.ts",
  "handlers/chat/tools/counterparty-check-tools.ts",
  "handlers/chat/tools/template-tools.ts",
  "handlers/contacts/business-registries/check.ts",
  "handlers/contacts/business-registries/lookup.ts",
  "handlers/desktop-registry/service.ts",
  "handlers/legislation/boe/law-structure/get.ts",
  "handlers/legislation/boe/laws/get.ts",
  "handlers/legislation/boe/related-laws/list.ts",
  "handlers/legislation/boe/search.ts",
  "handlers/legislation/boe/text-block/get.ts",
  "handlers/legislation/borme/summary/get.ts",
  "handlers/organization-settings/business-registry-credentials.ts",
  "handlers/reports/report-export-queue.ts",
  "handlers/templates/fill.ts",
  "handlers/templates/fills/create.ts",
  "handlers/templates/lookups/preview.ts",
  "lib/templates/fill-by-id-logic.ts",
  "lib/templates/fill-preview-logic.ts",
  "mcp/context.ts",
] as const;

/**
 * The API modules that may import a third-party package's network calls, each
 * of which takes a permit for them. A package's network calls are its exported
 * async functions, read from the module itself.
 */
const NETWORK_CALL_OWNERS = {
  "@stll/boe": ["lib/legal-search/boe-client.ts"],
  "@stll/business-registries": [
    "lib/business-registries/dispatch.ts",
    "lib/business-registries/entity-checks.ts",
  ],
} as const satisfies Record<string, readonly string[]>;

type ThirdPartyPackage = keyof typeof NETWORK_CALL_OWNERS;

const THIRD_PARTY_PACKAGES = Object.keys(NETWORK_CALL_OWNERS).filter(
  (name): name is ThirdPartyPackage => name in NETWORK_CALL_OWNERS,
);

const packageOf = (specifier: string): ThirdPartyPackage | undefined =>
  THIRD_PARTY_PACKAGES.find(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );

type ValueImport = {
  file: string;
  specifier: string;
  /** Imported binding names, or null for a namespace import. */
  names: readonly string[] | null;
};

const IMPORT_STATEMENT =
  /^import\s+(?!type\s)(?<clause>[^;]*?)\s+from\s+"(?<specifier>[^"]+)";/gmsu;

const valueImportsOf = (file: string, text: string): ValueImport[] =>
  [...text.matchAll(IMPORT_STATEMENT)].flatMap((match): ValueImport[] => {
    const clause = match.groups?.["clause"] ?? "";
    const specifier = match.groups?.["specifier"] ?? "";
    if (clause.startsWith("*")) {
      return [{ file, specifier, names: null }];
    }
    const named = /\{(?<names>[^}]*)\}/su.exec(clause)?.groups?.["names"];
    if (named === undefined) {
      return [];
    }
    const names = named
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !part.startsWith("type "))
      .map((part) => part.split(/\s+as\s+/u).at(0) ?? part);
    return [{ file, specifier, names }];
  });

const isAsyncFunction = (value: unknown): boolean =>
  typeof value === "function" && value.constructor.name === "AsyncFunction";

/** The exported async functions of one module specifier. */
const networkCallsOf = async (
  specifier: string,
): Promise<ReadonlySet<string>> => {
  const loaded: unknown = await import(specifier);
  if (!isRecord(loaded)) {
    return expect.unreachable(`${specifier} did not load as a module`);
  }
  return new Set(
    Object.entries(loaded)
      .filter(([, value]) => isAsyncFunction(value))
      .map(([name]) => name),
  );
};

describe("third-party outbound permits", () => {
  test("are granted only at the listed direct call boundaries", async () => {
    const granting = [...(await productionSources())]
      .filter(([, text]) => text.includes("grantThirdPartyOutboundPermit()"))
      .map(([file]) => file)
      .toSorted();
    expect(granting).toEqual([...PERMIT_GRANTING_SOURCES].toSorted());
  });

  test("guard every third-party network call a package exports", async () => {
    const sources = await productionSources();
    const imports = [...sources].flatMap(([file, text]) =>
      valueImportsOf(file, text),
    );
    const violations: string[] = [];
    const ownersSeen = new Set<string>();
    for (const { file, specifier, names } of imports) {
      const owningPackage = packageOf(specifier);
      if (owningPackage === undefined) {
        continue;
      }
      const networkCalls = await networkCallsOf(specifier);
      const imported =
        names === null
          ? [...networkCalls]
          : names.filter((name) => networkCalls.has(name));
      if (imported.length === 0) {
        continue;
      }
      const owners: readonly string[] = NETWORK_CALL_OWNERS[owningPackage];
      if (owners.includes(file)) {
        ownersSeen.add(file);
        continue;
      }
      violations.push(`${file}: ${imported.join(", ")} from ${specifier}`);
    }
    expect(violations).toEqual([]);
    // Anti-vacuity: each owner does import the calls it guards, so the
    // detection above sees real network calls.
    expect([...ownersSeen].toSorted()).toEqual(
      Object.values(NETWORK_CALL_OWNERS).flat().toSorted(),
    );
  });
});
