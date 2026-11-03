import { AssertionError, fail as panic } from "node:assert";

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

type RegistryName = (typeof PARSER_REGISTRY_NAMES)[number];

const REGISTRY_CONSTRAINTS = {
  ADAPTER_KEYS: "",
  IMPORT_SOURCE_KEYS: "",
  PARSER_VERSIONS: " satisfies Record<AdapterKey, number>",
  SOURCE_FINGERPRINT_VERSIONS:
    " satisfies Record<AdapterKey | ImportSourceKey, number>",
  PARSER_VERSION_SCOPES:
    " satisfies ParserVersionScopes<typeof PARSER_VERSIONS>",
} as const satisfies Record<RegistryName, string>;

type EntryFieldsOptions = {
  value: object;
  names: readonly string[];
  message: string;
};

const assertEntryFields = ({ value, names, message }: EntryFieldsOptions) => {
  const keys = Object.keys(value);
  if (
    keys.length !== names.length ||
    keys.some((key) => !names.includes(key))
  ) {
    panic(message);
  }
};

type EntryScope =
  | { type: "all"; reason: string }
  | { type: "features"; features: [string, ...string[]] };

const parseScope = (value: unknown, message: string): EntryScope => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return panic(message);
  }
  const type: unknown = Reflect.get(value, "type");
  switch (type) {
    case "all": {
      assertEntryFields({ value, names: ["type", "reason"], message });
      const reason: unknown = Reflect.get(value, "reason");
      if (typeof reason !== "string" || reason.trim() === "") {
        return panic(message);
      }
      return { type, reason };
    }
    case "features": {
      assertEntryFields({ value, names: ["type", "features"], message });
      const features: unknown = Reflect.get(value, "features");
      if (!Array.isArray(features)) {
        return panic(message);
      }
      const names = features.map((feature: unknown) => {
        if (typeof feature !== "string" || feature.trim() === "") {
          return panic(message);
        }
        return feature;
      });
      const [first, ...rest] = names;
      if (first === undefined) {
        return panic(message);
      }
      return { type, features: [first, ...rest] };
    }
    default:
      return panic(message);
  }
};

type SourceEntry = {
  name: string;
  key: string;
  sourceFingerprintVersion: number;
} & (
  | { type: "parser"; parserVersion: number; scope: EntryScope }
  | { type: "import" }
);

type ParseParserEntryOptions = {
  file: string;
  source: string;
};

const parseEntryJson = ({ file, source }: ParseParserEntryOptions): unknown => {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new AssertionError({
      message: `Invalid parser registry JSON: ${file}`,
      actual: error,
    });
  }
};

export const parseParserEntry = ({
  file,
  source,
}: ParseParserEntryOptions): SourceEntry => {
  const message = `Invalid parser registry entry: ${file}`;
  const value = parseEntryJson({ file, source });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return panic(message);
  }
  const name: unknown = Reflect.get(value, "name");
  const key: unknown = Reflect.get(value, "key");
  const sourceFingerprintVersion: unknown = Reflect.get(
    value,
    "sourceFingerprintVersion",
  );
  if (
    typeof name !== "string" ||
    !/^[A-Z][A-Z\d_]*$/u.test(name) ||
    typeof key !== "string" ||
    !/^[a-z][a-z\d-]*$/u.test(key) ||
    file !== `${PARSER_ENTRY_DIRECTORY}${key}.json` ||
    typeof sourceFingerprintVersion !== "number" ||
    !Number.isSafeInteger(sourceFingerprintVersion) ||
    sourceFingerprintVersion < 0
  ) {
    return panic(message);
  }
  const type: unknown = Reflect.get(value, "type");
  switch (type) {
    case "parser": {
      assertEntryFields({
        value,
        names: [
          "type",
          "name",
          "key",
          "sourceFingerprintVersion",
          "parserVersion",
          "scope",
        ],
        message,
      });
      const parserVersion: unknown = Reflect.get(value, "parserVersion");
      if (
        typeof parserVersion !== "number" ||
        !Number.isSafeInteger(parserVersion) ||
        parserVersion < 1
      ) {
        return panic(message);
      }
      return {
        type,
        name,
        key,
        sourceFingerprintVersion,
        parserVersion,
        scope: parseScope(Reflect.get(value, "scope"), message),
      };
    }
    case "import":
      assertEntryFields({
        value,
        names: ["type", "name", "key", "sourceFingerprintVersion"],
        message,
      });
      return { type, name, key, sourceFingerprintVersion };
    default:
      return panic(message);
  }
};

/** Inline source data so runtime imports never load the entry inventory. */
export const renderParserRegistry = (files: ReadonlyMap<string, string>) => {
  const entries = [...files]
    .filter(
      ([file]) =>
        file.startsWith(PARSER_ENTRY_DIRECTORY) && file.endsWith(".json"),
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
  const fields = new Map<RegistryName, string[]>(
    PARSER_REGISTRY_NAMES.map((name) => [name, []]),
  );
  const append = (name: RegistryName, property: string) => {
    const values =
      fields.get(name) ?? panic(`Missing registry projection: ${name}`);
    values.push(property);
  };
  const seenKeys = new Set<string>();
  const seenNames = new Set<string>();
  for (const [file, source] of entries) {
    const entry = parseParserEntry({ file, source });
    if (seenKeys.has(entry.key) || seenNames.has(entry.name)) {
      panic(`Duplicate parser registry entry: ${file}`);
    }
    seenKeys.add(entry.key);
    seenNames.add(entry.name);
    const keys =
      entry.type === "parser" ? "ADAPTER_KEYS" : "IMPORT_SOURCE_KEYS";
    append(keys, `  ${entry.name}: ${JSON.stringify(entry.key)},`);
    const key = `[${keys}.${entry.name}]`;
    append(
      "SOURCE_FINGERPRINT_VERSIONS",
      `  ${key}: ${entry.sourceFingerprintVersion},`,
    );
    switch (entry.type) {
      case "parser":
        append("PARSER_VERSIONS", `  ${key}: ${entry.parserVersion},`);
        append(
          "PARSER_VERSION_SCOPES",
          `  ${key}: { version: PARSER_VERSIONS${key}, scope: ${JSON.stringify(entry.scope)} },`,
        );
        break;
      case "import":
        break;
      default:
        entry satisfies never;
        throw new AssertionError({
          message: "Unhandled parser registry entry",
          actual: entry,
        });
    }
  }
  // A blank line between entries keeps every adapter's lines apart from its
  // neighbours', so two pull requests that change different adapters merge
  // without a textual conflict in this generated file. Changes to the same
  // adapter still conflict, in its JSON entry first.
  const declarations = PARSER_REGISTRY_NAMES.map((name) => {
    const values =
      fields.get(name) ?? panic(`Missing registry projection: ${name}`);
    return `export const ${name} = {\n${values.join("\n\n")}\n} as const${REGISTRY_CONSTRAINTS[name]};`;
  });
  return [
    "// Generated from parser-entries/*.json by scripts/generate-parser-registry.ts.",
    'import type { ParserVersionScopes } from "./parser-reparse-scopes";',
    "",
    ...declarations,
    "export type AdapterKey = (typeof ADAPTER_KEYS)[keyof typeof ADAPTER_KEYS];",
    "export type ImportSourceKey = (typeof IMPORT_SOURCE_KEYS)[keyof typeof IMPORT_SOURCE_KEYS];",
    "",
  ].join("\n");
};
