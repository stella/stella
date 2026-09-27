import { describe, expect, test } from "bun:test";
import ts from "typescript";

import { printContract } from "./generate-web-api-types";
import { nameAliases } from "./lib/web-api-alias-names";

// Alias names in apps/web/src/generated/api-routes.gen.ts must not move when
// an unrelated route or contract member is added, or every pull request that
// touches the file conflicts with every other one. These run the real printer
// on a small in-memory contract and compare the aliases before and after.

const CONTRACT_FILE = "/virtual/eden-contract.ts";

const aliasesOf = (source: string): Map<string, string> => {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) =>
    fileName === CONTRACT_FILE || fileExists(fileName);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === CONTRACT_FILE
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : getSourceFile(fileName, languageVersion, ...rest);
  const program = ts.createProgram({
    rootNames: [CONTRACT_FILE],
    options,
    host,
  });
  const contractSource = program.getSourceFile(CONTRACT_FILE);
  if (contractSource === undefined) {
    throw new Error("contract not loaded");
  }
  const result = printContract({
    program,
    contractSource,
    webDependencies: new Set(),
    responseDates: "wire",
  });
  return new Map(result.aliases.map(({ name, text }) => [name, text]));
};

const SHARED = `
type Shared = { id: string; tags: string[] };
type Failure = { error: string; code: number };
type Pair = { left: Shared; right: Shared };
// Reached only under \`v1\`, which sits after other intersection members.
type Note = { note: string; at: number };
`;

const BEFORE = `${SHARED}
type Routes = {
  items: { get: { response: { 200: Shared; 404: Failure } } };
  pairs: { get: { response: { 200: Pair | Failure; 404: Failure } } };
};
export type WebApiContract = {
  WebRoutes: Routes & {
    v1: {
      things: { post: { body: Shared; response: { 200: Pair; 400: Failure } } };
      notes: { get: { response: { 200: Note[] } }; post: { body: Note } };
    };
  };
};
`;

describe("generate-web-api-types alias names", () => {
  test("the fixture shares types, so it has aliases to keep", () => {
    expect(aliasesOf(BEFORE).size).toBeGreaterThanOrEqual(3);
  });

  test("inserting an intersection member and routes renames no alias", () => {
    const after = `${SHARED}
type Extra = { status: { get: { response: { 200: Shared | Failure } } } };
type Routes = {
  items: { get: { response: { 200: Shared; 404: Failure } } };
  pairs: { get: { response: { 200: Pair | Failure; 404: Failure } } };
  zones: { get: { response: { 200: Pair[]; 404: Failure } } };
};
export type WebApiContract = {
  WebRoutes: Routes & Extra & {
    v1: {
      things: { post: { body: Shared; response: { 200: Pair; 400: Failure } } };
      notes: { get: { response: { 200: Note[] } }; post: { body: Note } };
      tokens: { post: { body: Failure; response: { 200: Shared } } };
    };
  };
};
`;
    const before = aliasesOf(BEFORE);
    const added = aliasesOf(after);
    for (const [name, text] of before) {
      expect(added.get(name)).toBe(text);
    }
  });

  test("member and route order does not change any name", () => {
    const reordered = `${SHARED}
type Routes = {
  pairs: { get: { response: { 200: Failure | Pair; 404: Failure } } };
  items: { get: { response: { 200: Shared; 404: Failure } } };
};
export type WebApiContract = {
  WebRoutes: {
    v1: {
      things: { post: { body: Shared; response: { 200: Pair; 400: Failure } } };
      notes: { get: { response: { 200: Note[] } }; post: { body: Note } };
    };
  } & Routes;
};
`;
    expect(aliasesOf(reordered)).toEqual(aliasesOf(BEFORE));
  });
});

describe("nameAliases", () => {
  const TOKEN = (id: number) => `${id}`;

  test("names a shared node from its smallest path, not the first reach", () => {
    const nodes = [{ body: "{ id: string }", references: 2, recursive: false }];
    const firstZ = nameAliases(nodes, [
      { from: undefined, to: 0, path: "R/z" },
      { from: undefined, to: 0, path: "R/a" },
    ]);
    const firstA = nameAliases(nodes, [
      { from: undefined, to: 0, path: "R/a" },
      { from: undefined, to: 0, path: "R/z" },
    ]);
    expect(firstZ).toEqual(firstA);
  });

  test("tells apart same-path nodes by what they print, deeply", () => {
    // Two union members `{ s: X }` whose X differ only one level down.
    const nodes = [
      { body: `{ s: ${TOKEN(2)} }`, references: 2, recursive: false },
      { body: `{ s: ${TOKEN(3)} }`, references: 2, recursive: false },
      { body: "{ n: string }", references: 1, recursive: false },
      { body: "{ n: number }", references: 1, recursive: false },
    ];
    const edges = [
      { from: undefined, to: 0, path: "R/|" },
      { from: undefined, to: 1, path: "R/|" },
      { from: 0, to: 2, path: "s" },
      { from: 1, to: 3, path: "s" },
    ];
    const names = nameAliases(nodes, edges);
    expect(names.get(0)).toBeDefined();
    expect(names.get(0)).not.toBe(names.get(1));
  });

  test("same-path nodes that print the same type share one name", () => {
    const nodes = [
      { body: `{ next: ${TOKEN(0)} }`, references: 2, recursive: true },
      { body: `{ next: ${TOKEN(1)} }`, references: 2, recursive: true },
    ];
    const edges = [
      { from: undefined, to: 0, path: "R/|" },
      { from: undefined, to: 1, path: "R/|" },
      { from: 0, to: 0, path: "next" },
      { from: 1, to: 1, path: "next" },
    ];
    const names = nameAliases(nodes, edges);
    expect(names.get(0)).toBe(names.get(1));
  });
});
