import { expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript6";

import { normalizeCompatibilityDeclarations } from "./package-api-compatibility";
import { type ApiReport, breakingApiChanges } from "./package-api-report";

const report = (declaration: string) =>
  ({
    package: "@stll/fixture",
    entrypoints: {
      ".": {
        type: "module",
        file: "./src/index.d.ts",
        exports: [{ name: "Client", kind: "type", space: "type" }],
      },
    },
    declarations: {
      "./src/index.d.ts": normalizeCompatibilityDeclarations(declaration),
    },
  }) as const satisfies ApiReport;

test.each([
  "export interface Client { convert(input: INPUT): string; }",
  "export declare class Client { convert(input: INPUT): string; }",
  "export declare class Client { static convert(input: INPUT): string; }",
  "export type Client = { convert(input: INPUT): string; };",
  "export interface Client { convert?(input: INPUT): string; }",
  "export interface Client { convert<T extends INPUT>(input: T): string; }",
])("method input narrowing is rejected: %s", (declaration) => {
  const broad = report(declaration.replaceAll("INPUT", "string | number"));
  const narrow = report(declaration.replaceAll("INPUT", "string"));
  expect(
    breakingApiChanges({
      before: broad,
      after: narrow,
      packageDir: process.cwd(),
    }),
  ).toContainEqual(
    expect.objectContaining({
      type: "signature",
      entrypoint: ".",
      message: expect.stringContaining("incompatible"),
    }),
  );
});

test("overloaded methods retain every call signature", () => {
  const before = report(
    "export interface Client { convert(input: string): string; convert(input: number): number; }",
  );
  const after = report(
    "export interface Client { convert(input: string): string; }",
  );
  expect(
    breakingApiChanges({ before, after, packageDir: process.cwd() }),
  ).toContainEqual(
    expect.objectContaining({
      type: "signature",
      entrypoint: ".",
      message: expect.stringContaining("incompatible"),
    }),
  );
});

test("normalization is stable and preserves unchanged overloaded contracts", () => {
  const declaration =
    "export declare class Client { static convert<T extends string>(input: T): T; static convert(input: number): number; optional?(input: string): string; }";
  const normalized = normalizeCompatibilityDeclarations(declaration);
  expect(normalizeCompatibilityDeclarations(normalized)).toBe(normalized);
  expect(
    breakingApiChanges({
      before: report(declaration),
      after: report(normalized),
      packageDir: process.cwd(),
    }),
  ).toEqual([]);
});

const consumerDiagnostics = (declaration: string, consumer: string) => {
  const file = path.join(import.meta.dir, "__api-consumer__.ts");
  const source = ts.createSourceFile(
    file,
    `${declaration}\n${consumer}`,
    ts.ScriptTarget.ESNext,
    true,
  );
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    types: [],
    target: ts.ScriptTarget.ESNext,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) =>
    name === file ? source : getSourceFile(name, ...args);
  const program = ts.createProgram({ rootNames: [file], options, host });
  return [
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source),
  ].map((diagnostic) => ({
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }));
};

test.each(["interface", "declare class"])(
  "overloaded %s methods preserve polymorphic receivers and last-signature inference",
  (kind) => {
    const declaration = `export ${kind} Client<T extends { id: number }> {
      convert(value: T, peer: this): this;
      convert(value: number): number;
    }`;
    const consumer = `declare const client: Client<{ id: number; label: string }>;
      const same: typeof client = client.convert({ id: 1, label: "a" }, client);
      const number: number = client.convert(1);
      type Last = Parameters<typeof client.convert>;
      const args: Last = [1];
      interface Specialized extends Client<{ id: number; label: string }> { marker: true }
      declare const specialized: Specialized;
      const subtype: Specialized = specialized.convert({ id: 1, label: "a" }, specialized);`;
    expect(consumerDiagnostics(declaration, consumer)).toEqual([]);
    const normalized = normalizeCompatibilityDeclarations(declaration);
    expect(consumerDiagnostics(normalized, consumer)).toEqual([]);
    const invalidReceiver = `${consumer}\nspecialized.convert({ id: 1, label: "a" }, client);`;
    expect(
      consumerDiagnostics(declaration, invalidReceiver).length,
    ).toBeGreaterThan(0);
    expect(
      consumerDiagnostics(normalized, invalidReceiver).length,
    ).toBeGreaterThan(0);
    expect(normalizeCompatibilityDeclarations(normalized)).toBe(normalized);
    expect(
      breakingApiChanges({
        before: report(declaration),
        after: report(`${declaration}\nexport declare const added: number;`),
        packageDir: process.cwd(),
      }),
    ).toEqual([]);
  },
);

test.each(["interface", "declare class"])(
  "overloaded %s receiver methods still reject narrower inputs",
  (kind) => {
    const declaration = `export ${kind} Client {
      convert(value: INPUT, peer: this): this;
      convert(value: boolean): boolean;
    }`;
    const broad = declaration.replace("INPUT", "string | number");
    const narrow = declaration.replace("INPUT", "string");
    const consumer = "declare const client: Client; client.convert(1, client);";
    expect(consumerDiagnostics(broad, consumer)).toEqual([]);
    expect(consumerDiagnostics(narrow, consumer).length).toBeGreaterThan(0);
    expect(
      breakingApiChanges({
        before: report(broad),
        after: report(narrow),
        packageDir: process.cwd(),
      }),
    ).toContainEqual(
      expect.objectContaining({
        type: "signature",
        message: expect.stringContaining("incompatible"),
      }),
    );
  },
);

const receiverClass = (
  members: string,
  modifier = "",
  parameter = "T extends { id: number }",
) =>
  `export declare ${modifier}class Client<${parameter}> {
    convert(value: T, peer: this): this;
    convert(value: number): number;
    ${members}
  }`;

test.each([
  [
    "default type argument",
    receiverClass("", "", "T extends { id: number } = { id: 1 }"),
  ],
  ["abstract class", receiverClass("", "abstract ")],
  ["protected constructor", receiverClass("protected constructor();")],
  ["private constructor", receiverClass("private constructor();")],
])(
  "unchanged generic receiver %s retains its full value contract",
  (_name, declaration) => {
    expect(consumerDiagnostics(declaration, "")).toEqual([]);
    expect(
      breakingApiChanges({
        before: report(declaration),
        after: report(`${declaration}\nexport declare const added: number;`),
        packageDir: process.cwd(),
      }),
    ).toEqual([]);
  },
);

test("generic receiver constructor overloads can reorder without losing calls", () => {
  const before = receiverClass(
    'constructor(mode: "short"); constructor(mode: "long", count: number);',
  );
  const after = receiverClass(
    'constructor(mode: "long", count: number); constructor(mode: "short");',
  );
  const consumer = 'new Client("short"); new Client("long", 1);';
  expect(consumerDiagnostics(before, consumer)).toEqual([]);
  expect(consumerDiagnostics(after, consumer)).toEqual([]);
  expect(
    breakingApiChanges({
      before: report(before),
      after: report(after),
      packageDir: process.cwd(),
    }),
  ).toEqual([]);
});

test.each([
  {
    name: "a constructor input",
    before: receiverClass("constructor(value: string | number);"),
    after: receiverClass("constructor(value: string);"),
    consumer: "new Client(1);",
  },
  {
    name: "one discriminated constructor overload",
    before: receiverClass(
      'constructor(mode: "first", value: string | number); constructor(mode: "second", value: number);',
    ),
    after: receiverClass(
      'constructor(mode: "first", value: string); constructor(mode: "second", value: string | number);',
    ),
    consumer: 'new Client("first", 1);',
  },
  {
    name: "a generic constraint",
    before: receiverClass(""),
    after: receiverClass("", "", "T extends { id: number; label: string }"),
    consumer: "new Client<{ id: number }>();",
  },
  {
    name: "a generic parameter",
    before: receiverClass("", "", "T extends { id: number }, Extra = string"),
    after: receiverClass(""),
    consumer: "new Client<{ id: number }, number>();",
  },
  {
    name: "an omitted default type argument",
    before: receiverClass("", "", "T extends { id: number } = { id: 1 }"),
    after: receiverClass(""),
    consumer: "declare const client: Client;",
  },
  {
    name: "a default type argument's result",
    before: receiverClass(
      "value: T;",
      "",
      "T extends { id: number } = { id: 1 }",
    ),
    after: receiverClass(
      "value: T;",
      "",
      "T extends { id: number } = { id: 2 }",
    ),
    consumer: "const id: 1 = new Client().value.id;",
  },
  {
    name: "a static input",
    before: receiverClass("static use(value: string | number): void;"),
    after: receiverClass("static use(value: string): void;"),
    consumer: "Client.use(1);",
  },
  {
    name: "a static member",
    before: receiverClass("static option: number;"),
    after: receiverClass(""),
    consumer: "const value: number = Client.option;",
  },
  {
    name: "a writable static member",
    before: receiverClass("static option: number;"),
    after: receiverClass("static readonly option: number;"),
    consumer: "Client.option = 1;",
  },
  {
    name: "a prototype input",
    before: receiverClass("use(value: string | number): void;"),
    after: receiverClass("use(value: string): void;"),
    consumer: "new Client().use(1);",
  },
  {
    name: "an instance member",
    before: receiverClass("option: number;"),
    after: receiverClass(""),
    consumer: "const value: number = new Client().option;",
  },
  {
    name: "public construction",
    before: receiverClass(""),
    after: receiverClass("", "abstract "),
    consumer: "new Client();",
  },
  {
    name: "protected construction",
    before: receiverClass("protected constructor();"),
    after: receiverClass("private constructor();"),
    consumer:
      "class Derived extends Client<{ id: number }> { constructor() { super(); } }",
  },
])(
  "generic receiver comparisons reject loss of $name",
  ({ before, after, consumer }) => {
    expect(consumerDiagnostics(before, consumer)).toEqual([]);
    expect(consumerDiagnostics(after, consumer).length).toBeGreaterThan(0);
    expect(
      breakingApiChanges({
        before: report(before),
        after: report(after),
        packageDir: process.cwd(),
      }).length,
    ).toBeGreaterThan(0);
  },
);

test.each([
  "private state: string; private refresh(): void;",
  "#state;",
  "protected state: string; protected refresh(): void;",
  "protected get state(): string; protected set state(value: string);",
])(
  "unrelated additions preserve a class with nonpublic state: %s",
  (members) => {
    const declaration = `export declare class Client { ${members} public read(): string; }`;
    const before = report(declaration);
    const after = report(`${declaration}\nexport declare const added: number;`);
    expect(before.declarations).not.toEqual(after.declarations);
    expect(
      breakingApiChanges({ before, after, packageDir: process.cwd() }),
    ).toEqual([]);
  },
);

test("moving a public class member to protected is visible", () => {
  const before = report("export declare class Client { read(): string; }");
  const after = report(
    "export declare class Client { protected read(): string; }",
  );
  expect(
    breakingApiChanges({ before, after, packageDir: process.cwd() }),
  ).toContainEqual(
    expect.objectContaining({
      type: "signature",
      entrypoint: ".",
      message: expect.stringContaining("incompatible"),
    }),
  );
});

test("private constructors retain their construction restriction", () => {
  const normalized = normalizeCompatibilityDeclarations(
    "export declare class Client { private constructor(); private state: string; }",
  );
  expect(normalized).toContain("private constructor()");
  expect(normalized).not.toContain("state");
});

test.each([
  [
    "export interface Client { value?: string; read(): string; }",
    "export interface Client { read(): string; }",
    "removed member value",
  ],
  [
    "export type Client = { value?: string };",
    "export type Client = {};",
    "removed member value",
  ],
  [
    "export interface Client { value: number; }",
    "export interface Client { readonly value: number; }",
    "member value became readonly",
  ],
  [
    "export declare class Client { value: number; }",
    "export declare class Client { get value(): number; }",
    "member value became readonly",
  ],
])("assignable member narrowing is visible: %s", (old, next, message) => {
  expect(
    breakingApiChanges({
      before: report(old),
      after: report(next),
      packageDir: process.cwd(),
    }),
  ).toContainEqual(
    expect.objectContaining({
      type: "signature",
      entrypoint: ".",
      message: expect.stringContaining(message),
    }),
  );
});

test("an optional member removed from an exported value's type is visible", () => {
  const value = (declaration: string) =>
    ({
      ...report(""),
      entrypoints: {
        ".": {
          type: "module",
          file: "./src/index.d.ts",
          exports: [{ name: "options", kind: "value", space: "value" }],
        },
      },
      declarations: {
        "./src/index.d.ts": normalizeCompatibilityDeclarations(declaration),
      },
    }) as const satisfies ApiReport;
  expect(
    breakingApiChanges({
      before: value("export declare const options: { value?: string };"),
      after: value("export declare const options: {};"),
      packageDir: process.cwd(),
    }),
  ).toContainEqual(
    expect.objectContaining({
      message: expect.stringContaining("removed member value"),
    }),
  );
});

test("adding members and widening readonly to writable stay compatible", () => {
  const before = report("export interface Client { readonly value: number; }");
  const after = report(
    "export interface Client { value: number; extra?: string; }",
  );
  expect(
    breakingApiChanges({ before, after, packageDir: process.cwd() }),
  ).toEqual([]);
});

test("two aliases of one namespace are compared against each new target", () => {
  const aliases = (declaration: string) =>
    ({
      ...report(""),
      entrypoints: {
        ".": {
          type: "module",
          file: "./src/index.d.ts",
          exports: [
            { name: "One", kind: "namespace", space: "type+value" },
            { name: "Two", kind: "namespace", space: "type+value" },
          ],
        },
      },
      declarations: {
        "./src/index.d.ts": normalizeCompatibilityDeclarations(declaration),
      },
    }) as const satisfies ApiReport;
  const before = aliases(
    "declare namespace Model { type Input = string; const value = 1; }\nexport { Model as One, Model as Two };\n",
  );
  const after = aliases(
    "declare namespace Model { type Input = string; const value = 1; }\ndeclare namespace Other { const value = 1; }\nexport { Model as One, Other as Two };\n",
  );
  expect(
    breakingApiChanges({ before, after, packageDir: process.cwd() }),
  ).toContainEqual(
    expect.objectContaining({
      type: "removal",
      message: expect.stringContaining(".#Two.Input: removed export"),
    }),
  );
});

test("a brand keyed on a unique symbol compares equal to itself across the two trees", () => {
  const branded = (tag: string) =>
    report(
      `declare const __brand: unique symbol;\nexport type Client = number & { readonly [__brand]: "${tag}" };\n`,
    );
  expect(
    breakingApiChanges({
      before: branded("Client"),
      after: { ...branded("Client"), package: "@stll/fixture-next" },
      packageDir: process.cwd(),
    }),
  ).toEqual([]);
  expect(
    breakingApiChanges({
      before: branded("Client"),
      after: branded("Other"),
      packageDir: process.cwd(),
    }),
  ).toContainEqual(
    expect.objectContaining({
      message: expect.stringContaining("incompatible type signature"),
    }),
  );
});

test.each([
  {
    name: "equivalent default aliases",
    before:
      "type Default = { id: 1 }; export interface Client<T = Default> { value: T }",
    after:
      "type Default = { id: 1 }; type Equivalent = Default; export interface Client<T = Equivalent> { value: T }",
    consumer: "declare const client: Client; const id: 1 = client.value.id;",
  },
  {
    name: "defaults depending on an earlier argument",
    before:
      "type Box<T> = { value: T }; export type Client<T, U = Box<T>> = { first: T; second: U };",
    after:
      "type Box<T> = { value: T }; export type Client<T, U = { value: T }> = { first: T; second: U };",
    consumer:
      "declare const client: Client<string>; const value: string = client.second.value;",
  },
  {
    name: "each omitted suffix with renamed parameters",
    before:
      "export interface Client<T = string, U = readonly T[]> { first: T; second: U }",
    after:
      "export interface Client<A = string, B = ReadonlyArray<A>> { first: A; second: B }",
    consumer:
      "declare const defaulted: Client; declare const explicit: Client<number>; const strings: readonly string[] = defaulted.second; const numbers: readonly number[] = explicit.second;",
  },
  {
    name: "an added default",
    before: "export interface Client<T> { value: T }",
    after: "export interface Client<T = string> { value: T }",
    consumer:
      "declare const client: Client<number>; const value: number = client.value;",
  },
  {
    name: "a default unused by the public type",
    before: "export type Client<T = string> = { value: number };",
    after: "export type Client<T = boolean> = { value: number };",
    consumer:
      "declare const client: Client; const value: number = client.value;",
  },
])(
  "generic default comparison preserves $name",
  ({ before, after, consumer }) => {
    expect(consumerDiagnostics(before, consumer)).toEqual([]);
    expect(consumerDiagnostics(after, consumer)).toEqual([]);
    expect(
      breakingApiChanges({
        before: report(before),
        after: report(after),
        packageDir: process.cwd(),
      }),
    ).toEqual([]);
  },
);

test.each([
  {
    name: "changed dependent default",
    before: "export interface Client<T, U = T[]> { value: U }",
    after: "export interface Client<T, U = T> { value: U }",
    consumer:
      "declare const client: Client<number>; const value: number[] = client.value;",
  },
  {
    name: "removed default after an explicit argument",
    before: "export interface Client<T, U = T[]> { value: U }",
    after: "export interface Client<T, U> { value: U }",
    consumer: "declare const client: Client<number>;",
  },
  {
    name: "changed alias default",
    before: "export type Client<T = string> = { value: T };",
    after: "export type Client<T = number> = { value: T };",
    consumer:
      "declare const client: Client; const value: string = client.value;",
  },
])(
  "generic default comparison rejects $name",
  ({ before, after, consumer }) => {
    expect(consumerDiagnostics(before, consumer)).toEqual([]);
    expect(consumerDiagnostics(after, consumer).length).toBeGreaterThan(0);
    expect(
      breakingApiChanges({
        before: report(before),
        after: report(after),
        packageDir: process.cwd(),
      }).length,
    ).toBeGreaterThan(0);
  },
);

test.each(["interface-first", "class-first"])(
  "merged generic declarations retain their value contract: %s",
  (order) => {
    const declarations = [
      "export interface Client<T = string> { value: T }",
      "export declare class Client<T> { constructor(value: T); }",
    ];
    const declaration = (
      order === "interface-first" ? declarations : declarations.toReversed()
    ).join("\n");
    const consumer =
      'const client: Client = new Client("value"); const value: string = client.value;';
    expect(consumerDiagnostics(declaration, consumer)).toEqual([]);
    expect(
      breakingApiChanges({
        before: report(declaration),
        after: report(`${declaration}\nexport declare const added: number;`),
        packageDir: process.cwd(),
      }),
    ).toEqual([]);
  },
);

test.each(["interface-first", "class-first"])(
  "merged constructor inputs reject broken consumers: %s",
  (order) => {
    const declarations = [
      "export interface Client<T> { value: T }",
      "export declare class Client<T> { constructor(value: INPUT); }",
    ];
    const shape = (
      order === "interface-first" ? declarations : declarations.toReversed()
    ).join("\n");
    const before = shape.replace("INPUT", "string | number");
    const after = shape.replace("INPUT", "string");
    const consumer = "new Client(1);";
    expect(consumerDiagnostics(before, consumer)).toEqual([]);
    expect(consumerDiagnostics(after, consumer).length).toBeGreaterThan(0);
    expect(
      breakingApiChanges({
        before: report(before),
        after: report(after),
        packageDir: process.cwd(),
      }).length,
    ).toBeGreaterThan(0);
  },
);

const MERGED_DEFAULT_CASES = [
  {
    name: "a later interface default",
    before:
      "export interface Client<T> { value: T } export interface Client<T = string> {}",
    after:
      "export interface Client<T> { value: T } export interface Client<T = number> {}",
    consumer:
      "declare const client: Client; const value: string = client.value;",
  },
  {
    name: "a later dependent default",
    before:
      "export interface Client<T, U> { value: U } export interface Client<T, U = T[]> {}",
    after:
      "export interface Client<T, U> { value: U } export interface Client<T, U = T> {}",
    consumer:
      "declare const client: Client<number>; const value: number[] = client.value;",
  },
  {
    name: "a readonly member in a default",
    before: "export interface Client<T = { option: number }> { value: T }",
    after:
      "export interface Client<T = { readonly option: number }> { value: T }",
    consumer: "declare const client: Client; client.value.option = 1;",
  },
  {
    name: "an optional member in a default",
    before:
      "export interface Client<T = { stable: string; option?: number }> { value: T }",
    after: "export interface Client<T = { stable: string }> { value: T }",
    consumer:
      "declare const client: Client; const option: number | undefined = client.value.option;",
  },
  {
    name: "a readonly member in a dependent default",
    before: "export interface Client<T, U = { option: T }> { value: U }",
    after:
      "export interface Client<T, U = { readonly option: T }> { value: U }",
    consumer: "declare const client: Client<number>; client.value.option = 1;",
  },
  {
    name: "a namespace-merged constructor",
    before:
      'export declare class Client<T> { value: T; constructor(value: string | number); } export declare namespace Client { const kind: "client"; }',
    after:
      'export declare class Client<T> { value: T; constructor(value: string); } export declare namespace Client { const kind: "client"; }',
    consumer: "new Client(1);",
  },
  {
    name: "a namespace-merged writable static member",
    before:
      'export declare class Client<T> { value: T; static option: number; } export declare namespace Client { const kind: "client"; }',
    after:
      'export declare class Client<T> { value: T; static readonly option: number; } export declare namespace Client { const kind: "client"; }',
    consumer: "Client.option = 1;",
  },
  {
    name: "a namespace-only member beside a class",
    before:
      'export declare class Client<T> { value: T; } export declare namespace Client { const kind: "client"; const option: number; }',
    after:
      'export declare class Client<T> { value: T; } export declare namespace Client { const kind: "client"; }',
    consumer: "const value: number = Client.option;",
  },
  {
    name: "an inherited library constructor",
    before: "export declare class Client<T> extends Error { value: T }",
    after:
      'export declare class Client<T> extends Error { value: T; constructor(message: "allowed"); }',
    consumer: 'new Client<string>("message");',
  },
] as const;

test.each(MERGED_DEFAULT_CASES)(
  "merged and inherited contracts reject loss of $name",
  ({ before, after, consumer }) => {
    expect(consumerDiagnostics(before, consumer)).toEqual([]);
    expect(consumerDiagnostics(after, consumer).length).toBeGreaterThan(0);
    expect(
      breakingApiChanges({
        before: report(before),
        after: report(after),
        packageDir: process.cwd(),
      }).length,
    ).toBeGreaterThan(0);
  },
);

test.each([
  {
    name: "a later merged default",
    declaration:
      "export interface Client<T> { value: T } export interface Client<T = string> {}",
    consumer:
      "declare const client: Client; const value: string = client.value;",
  },
  {
    name: "a namespace-merged class",
    declaration:
      'export declare class Client<T> { value: T; constructor(value: string | number); } export declare namespace Client { const kind: "client"; }',
    consumer: 'new Client<number>(1); const kind: "client" = Client.kind;',
  },
  {
    name: "an inherited library constructor",
    declaration: "export declare class Client<T> extends Error { value: T }",
    consumer: 'new Client<string>("message", { cause: new Error("cause") });',
  },
  {
    name: "an inherited package constructor with scoped parameter aliases",
    declaration:
      "export declare namespace Base { export type Input = string | number; export class Parent<T> { constructor(value: Input); value: T; } } export declare class Client<T> extends Base.Parent<T> {}",
    consumer: 'new Client<number>(1); new Client<string>("value");',
  },
])(
  "merged and inherited contracts preserve $name",
  ({ declaration, consumer }) => {
    expect(consumerDiagnostics(declaration, consumer)).toEqual([]);
    expect(
      breakingApiChanges({
        before: report(declaration),
        after: report(`${declaration}\nexport declare const added: number;`),
        packageDir: process.cwd(),
      }),
    ).toEqual([]);
  },
);
