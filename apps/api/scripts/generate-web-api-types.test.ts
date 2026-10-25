import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { SymbolFlags, type Type } from "typescript/unstable/async";

import {
  packageOfFile,
  printContract,
  verifyDeterminism,
} from "./generate-web-api-types";
import { nameAliases } from "./lib/web-api-alias-names";
import {
  type ContractProgram,
  openContractProgram,
} from "./lib/web-api-program";

// Alias names in apps/web/src/generated/api-routes.gen.ts must not move when
// an unrelated route or contract member is added, or every pull request that
// touches the file conflicts with every other one. These run the real printer
// on a small in-memory contract and compare the aliases before and after.

// Resolve package imports from the API's dependency tree, as the real contract
// does. Absolute declaration paths can create a second library symbol identity.
const CONTRACT_FILE = path.resolve(import.meta.dir, "__printer-contract__.ts");

describe("web API type determinism", () => {
  test("accepts matching prepared bytes without regenerating", () => {
    let regenerations = 0;
    const reference = verifyDeterminism({
      output: "generated output",
      prepared: Buffer.from("generated output"),
      regenerate: () => {
        regenerations += 1;
        return "generated output";
      },
    });

    expect(reference).toBe("prepared printout");
    expect(regenerations).toBe(0);
  });

  test("rejects different prepared bytes without regenerating", () => {
    let regenerations = 0;
    expect(() =>
      verifyDeterminism({
        output: "this run",
        prepared: Buffer.from("prepared output"),
        regenerate: () => {
          regenerations += 1;
          return "this run";
        },
      }),
    ).toThrow("prepared printout differs from this run");
    expect(regenerations).toBe(0);
  });

  test("accepts one matching regeneration when prepared bytes are unavailable", () => {
    let regenerations = 0;
    expect(
      verifyDeterminism({
        output: "generated output",
        prepared: undefined,
        regenerate: () => {
          regenerations += 1;
          return "generated output";
        },
      }),
    ).toBe("two generations");
    expect(regenerations).toBe(1);
  });

  test("rejects one different regeneration when prepared bytes are unavailable", () => {
    let regenerations = 0;
    expect(() =>
      verifyDeterminism({
        output: "different output",
        prepared: undefined,
        regenerate: () => {
          regenerations += 1;
          return "generated output";
        },
      }),
    ).toThrow("output is not deterministic across two generations");
    expect(regenerations).toBe(1);
  });
});

// Each program runs its own compiler process, closed after every test.
const opened: ContractProgram[] = [];
afterEach(async () => {
  for (const program of opened.splice(0)) {
    await program.close();
  }
});

const programOf = async (
  source: string,
  webDependencies: ReadonlySet<string> = new Set(),
): Promise<ContractProgram> => {
  const program = await openContractProgram({
    contractPath: CONTRACT_FILE,
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "esnext",
      module: "esnext",
      moduleResolution: "bundler",
    },
    virtualFiles: new Map([[CONTRACT_FILE, source]]),
    packageOf: packageOfFile,
    webDependencies,
  });
  opened.push(program);
  return program;
};

const printSource = async (program: ContractProgram) =>
  await printContract({
    program,
    webDependencies: new Set(),
    responseDates: "wire",
  });

const aliasesOf = async (source: string): Promise<Map<string, string>> =>
  new Map(
    (await printSource(await programOf(source))).aliases.map(
      ({ name, text }) => [name, text],
    ),
  );

test("preserves an imported generic interface behind a local alias", async () => {
  const webDependencies = new Set(["@standard-schema/spec"]);
  const program = await programOf(
    `
import type { StandardTypedV1 } from "@standard-schema/spec";
type Local<Input> = StandardTypedV1<Input, string>;
export type WebApiContract = { Tool: Local<number> };
`,
    webDependencies,
  );
  const { checker } = program;
  const tool = (
    await checker.getPropertiesOfType(
      await declaredType(program, "WebApiContract"),
    )
  ).at(0);
  expect(tool).toBeDefined();
  if (tool === undefined) {
    panic("Imported interface fixture lost its tool property");
  }
  // A local alias must reach the imported interface, rather than bypassing
  // the fault by referring to the package export directly.
  const toolType =
    (await checker.getTypeOfSymbol(tool)) ?? panic("tool has no type");
  expect((await toolType.getAliasSymbol())?.name).toBe("Local");
  const result = await printContract({
    program,
    webDependencies,
    responseDates: "wire",
  });
  expect(result.declarations.at(0)?.text).toBe(
    "standard_schema_spec_StandardTypedV1<number, string>",
  );
});

test("preserves imported generic interfaces inside client-tool schema arguments", async () => {
  const webDependencies = new Set(["@standard-schema/spec", "@tanstack/ai"]);
  const program = await programOf(
    `
import type { StandardSchemaV1, StandardJSONSchemaV1 } from "@standard-schema/spec";
import type { ClientTool } from "@tanstack/ai";
type LocalSchema<Input> = StandardSchemaV1<Input, string> & StandardJSONSchemaV1<Input, string>;
type LocalTool = ClientTool<LocalSchema<number>, undefined, "save">;
export type WebApiContract = { Tool: LocalTool };
`,
    webDependencies,
  );
  const result = await printContract({
    program,
    webDependencies,
    responseDates: "wire",
  });
  expect(result.packageReferences.get("@tanstack/ai#ClientTool")).toBe(1);
  expect(
    result.packageReferences.get("@standard-schema/spec#StandardSchemaV1"),
  ).toBe(1);
  expect(
    result.packageReferences.get("@standard-schema/spec#StandardJSONSchemaV1"),
  ).toBe(1);
  expect(result.declarations.at(0)?.text).toContain("tanstack_ai_ClientTool<");
});

// A type alias declared in the contract module, resolved by the checker.
const declaredType = async (
  { checker, contractSource }: ContractProgram,
  name: string,
): Promise<Type> => {
  const symbol = await checker.resolveName(
    name,
    SymbolFlags.TypeAlias,
    contractSource,
    true,
  );
  if (symbol === undefined) {
    throw new Error(`type ${name} not declared`);
  }
  return await checker.getDeclaredTypeOfSymbol(symbol);
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
  test("the fixture shares types, so it has aliases to keep", async () => {
    expect((await aliasesOf(BEFORE)).size).toBeGreaterThanOrEqual(3);
  });

  test("inserting an intersection member and routes renames no alias", async () => {
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
    const before = await aliasesOf(BEFORE);
    const added = await aliasesOf(after);
    for (const [name, text] of before) {
      expect(added.get(name)).toBe(text);
    }
  });

  test("member and route order does not change any name", async () => {
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
    expect(await aliasesOf(reordered)).toEqual(await aliasesOf(BEFORE));
  });
});

// The compiler orders union members by type id, so by whichever member the
// checker created first. `Primer` is resolved before printing and creates the
// same member types in the opposite order; the contract itself is identical.
const REVIEW = `
type Review = {
  impact?: "unknown" | "neutral" | "favourable" | "unfavourable";
  score: 3 | 1 | 2 | 10 | null | undefined;
  size: 10n | 2n;
  mode: boolean | "auto";
  list: string[] | number[];
  tag: string | null;
};
export type WebApiContract = {
  WebRoutes: {
    reviews: { get: { response: { 200: Review; 404: { error: string } } } };
  };
};
`;
const PRIMER = `
type Primer =
  | "unfavourable" | "favourable" | "neutral" | "auto"
  | 10 | 2 | 1 | 3 | 2n | 10n | number[] | string[];
`;

describe("generate-web-api-types union member order", () => {
  const printed = async (primed: boolean) => {
    const compiled = await programOf(`${primed ? PRIMER : ""}${REVIEW}`);
    const { checker } = compiled;
    if (primed) {
      await declaredType(compiled, "Primer");
    }
    const review = await declaredType(compiled, "Review");
    const compilerOrder: string[][] = [];
    for (const property of await checker.getPropertiesOfType(review)) {
      const type =
        (await checker.getTypeOfSymbol(property)) ??
        panic("property has no type");
      const members = type.isUnionType() ? await type.getTypes() : [type];
      const names: string[] = [];
      for (const member of members) {
        names.push(await checker.typeToString(member));
      }
      compilerOrder.push(names);
    }
    return { compilerOrder, result: await printSource(compiled) };
  };

  test("prints the same text whichever member the checker created first", async () => {
    const natural = await printed(false);
    const primed = await printed(true);
    // The fixture reaches the fault: the compiler's own member order differs.
    expect(primed.compilerOrder).not.toEqual(natural.compilerOrder);
    expect(primed.result.declarations).toEqual(natural.result.declarations);
    expect(primed.result.aliases).toEqual(natural.result.aliases);
  });

  test("orders literals by value, then null, then undefined", async () => {
    const [routes] = (await printed(false)).result.declarations;
    const text = routes?.text ?? "";
    expect(text).toContain(
      'impact?: "favourable" | "neutral" | "unfavourable" | "unknown" | undefined;',
    );
    expect(text).toContain("score: (1 | 2 | 3 | 10 | null | undefined);");
    expect(text).toContain("size: (2n | 10n);");
    expect(text).toContain('mode: ("auto" | false | true);');
    expect(text).toContain("list: (Array<number> | Array<string>);");
    expect(text).toContain("tag: (string | null)");
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
  test("adding a member under a union renames none already there", () => {
    const shared = { body: "{ id: string }", references: 2, recursive: false };
    const alone = nameAliases(
      [shared],
      [{ from: undefined, to: 0, path: "R/|" }],
    );
    const joined = nameAliases(
      [shared, { body: "{ code: number }", references: 2, recursive: false }],
      [
        { from: undefined, to: 0, path: "R/|" },
        { from: undefined, to: 1, path: "R/|" },
      ],
    );
    expect(joined.get(0)).toBe(alone.get(0));
  });

  test("mutually recursive union members keep their names in any order", () => {
    // `A = { a: B }` and `B = { b: A }`, both members of one union, numbered
    // in either order.
    const named = (order: readonly ("A" | "B")[]) => {
      const idOf = (name: "A" | "B") => order.indexOf(name);
      const bodyOf = (name: "A" | "B") =>
        name === "A"
          ? `{ a: ${TOKEN(idOf("B"))} }`
          : `{ b: ${TOKEN(idOf("A"))} }`;
      const names = nameAliases(
        order.map((name) => ({
          body: bodyOf(name),
          references: 2,
          recursive: true,
        })),
        [
          ...order.map((_, id) => ({ from: undefined, to: id, path: "R/|" })),
          { from: idOf("A"), to: idOf("B"), path: "a" },
          { from: idOf("B"), to: idOf("A"), path: "b" },
        ],
      );
      return { A: names.get(idOf("A")), B: names.get(idOf("B")) };
    };
    const ab = named(["A", "B"]);
    expect(ab.A).not.toBe(ab.B);
    expect(named(["B", "A"])).toEqual(ab);
  });

  test("hashes a densely recursive component without unfolding its paths", () => {
    // Every member refers to every member: unfolding each path from each
    // member would take factorial time.
    const size = 16;
    const ids = Array.from({ length: size }, (_, id) => id);
    const nodes = ids.map((id) => ({
      body: `{ k${id}: ${ids.map((other) => TOKEN(other)).join(" | ")} }`,
      references: 2,
      recursive: true,
    }));
    const edges = [
      ...ids.map((id) => ({ from: undefined, to: id, path: "R/|" })),
      ...ids.flatMap((id) =>
        ids.map((other) => ({ from: id, to: other, path: `k${id}/|` })),
      ),
    ];
    const names = nameAliases(nodes, edges);
    expect(new Set(names.values()).size).toBe(size);
  });
});
