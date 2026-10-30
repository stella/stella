import { panic } from "better-result";

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
  for (const [index, [file, source]] of entries.entries()) {
    const names = PARSER_REGISTRY_NAMES.filter((name) =>
      new RegExp(`export const ${name}\\s*=`, "u").test(source),
    );
    const expected = names.includes("ADAPTER_KEYS")
      ? PARSER_REGISTRY_NAMES.filter((name) => name !== "IMPORT_SOURCE_KEYS")
      : ["IMPORT_SOURCE_KEYS", "SOURCE_FINGERPRINT_VERSIONS"];
    if (names.join(",") !== expected.join(",")) {
      panic(`Incomplete parser registry entry: ${file}`);
    }
    const bindings = names.map((name) => {
      const alias = `${name}_${index}`;
      const values = spreads.get(name) ?? [];
      values.push(`  ...${alias},`);
      spreads.set(name, values);
      return `${name} as ${alias}`;
    });
    const relative = file.slice(PARSER_ENTRY_DIRECTORY.length, -3);
    imports.push(
      `import { ${bindings.join(", ")} } from "./parser-entries/${relative}";`,
    );
  }
  const declarations = PARSER_REGISTRY_NAMES.map((name) => {
    const suffix = REGISTRY_CONSTRAINTS[name];
    return `export const ${name} = {\n${(spreads.get(name) ?? []).join("\n")}\n} as const${suffix};`;
  });
  return [
    "// Generated from parser-entries/*.ts. Do not commit this derived index.",
    'import type { ParserVersionScopes } from "./parser-reparse-scopes";',
    ...imports,
    ...declarations,
    "export type AdapterKey = (typeof ADAPTER_KEYS)[keyof typeof ADAPTER_KEYS];",
    "export type ImportSourceKey = (typeof IMPORT_SOURCE_KEYS)[keyof typeof IMPORT_SOURCE_KEYS];",
    "",
  ].join("\n");
};
