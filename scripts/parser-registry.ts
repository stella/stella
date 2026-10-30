import { fail as panic } from "node:assert";

export const PARSER_ENTRY_DIRECTORY =
  "apps/api/src/lib/legal-search/parser-entries/";
export const PARSER_REGISTRY_OUTPUT =
  "apps/api/src/lib/legal-search/parser-registry.gen.ts";

export const PARSER_REGISTRY_NAMES = [
  "ADAPTER_KEYS",
  "IMPORT_SOURCE_KEYS",
  "PARSER_VERSIONS",
  "SOURCE_FINGERPRINT_VERSIONS",
  "PARSER_VERSION_SCOPES",
] as const;

const REGISTRY_CONSTRAINTS = {
  ADAPTER_KEYS: "",
  IMPORT_SOURCE_KEYS: "",
  PARSER_VERSIONS: " satisfies Record<AdapterKey, number>",
  SOURCE_FINGERPRINT_VERSIONS:
    " satisfies Record<AdapterKey | ImportSourceKey, number>",
  PARSER_VERSION_SCOPES:
    " satisfies ParserVersionScopes<typeof PARSER_VERSIONS>",
} as const satisfies Record<(typeof PARSER_REGISTRY_NAMES)[number], string>;

/** Render from committed entry paths, including when reading an immutable Git tree. */
export const renderParserRegistry = (files: ReadonlyMap<string, string>) => {
  const entries = [...files]
    .filter(
      ([file]) =>
        file.startsWith(PARSER_ENTRY_DIRECTORY) && file.endsWith(".ts"),
    )
    .toSorted(([left], [right]) => {
      if (left < right) {
        return -1;
      }
      return left > right ? 1 : 0;
    });
  if (entries.length === 0) {
    return undefined;
  }
  const imports: string[] = [];
  const spreads = new Map<string, string[]>();
  for (const [file, source] of entries) {
    const relative = file.slice(PARSER_ENTRY_DIRECTORY.length, -3);
    if (!/^[a-z][a-z\d-]*$/u.test(relative)) {
      panic(`Invalid parser registry entry path: ${file}`);
    }
    const suffix = relative.replaceAll("-", "_");
    const exports = new Bun.Transpiler({ loader: "ts" }).scan(source).exports;
    const names = PARSER_REGISTRY_NAMES.filter((name) =>
      exports.includes(name),
    );
    const expected = names.includes("ADAPTER_KEYS")
      ? PARSER_REGISTRY_NAMES.filter((name) => name !== "IMPORT_SOURCE_KEYS")
      : ["IMPORT_SOURCE_KEYS", "SOURCE_FINGERPRINT_VERSIONS"];
    if (
      names.join(",") !== expected.join(",") ||
      exports.length !== names.length
    ) {
      panic(`Incomplete parser registry entry: ${file}`);
    }
    const bindings = names.map((name) => {
      const alias = `${name}_${suffix}`;
      const values = spreads.get(name) ?? [];
      values.push(`  ...${alias},`);
      spreads.set(name, values);
      return `${name} as ${alias}`;
    });
    imports.push(
      `import { ${bindings.join(", ")} } from "./parser-entries/${relative}";`,
    );
  }
  const declarations = PARSER_REGISTRY_NAMES.map((name) => {
    const suffix = REGISTRY_CONSTRAINTS[name];
    return `export const ${name} = {\n${(spreads.get(name) ?? []).join("\n")}\n} as const${suffix};`;
  });
  return [
    "// Generated from parser-entries/*.ts by scripts/generate-parser-registry.ts.",
    'import type { ParserVersionScopes } from "./parser-reparse-scopes";',
    ...imports,
    "",
    ...declarations,
    "export type AdapterKey = (typeof ADAPTER_KEYS)[keyof typeof ADAPTER_KEYS];",
    "export type ImportSourceKey = (typeof IMPORT_SOURCE_KEYS)[keyof typeof IMPORT_SOURCE_KEYS];",
    "",
  ].join("\n");
};
