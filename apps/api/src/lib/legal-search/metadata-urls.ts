import { panic } from "better-result";

import {
  METADATA_URL_DEFECT_REASONS,
  MetadataUrlDefect,
  toMetadataUrl,
  type SafeHref,
} from "@/api/lib/sanitize-url";
import { includes, isRecord } from "@/api/lib/type-guards";

export const META_URL_DIAGNOSTICS = "metadataUrlDiagnostics";

type SourceUrl = SafeHref | MetadataUrlDefect | undefined;
export type MetadataUrlSchema<Value> = unknown extends Value
  ? never
  : [NonNullable<Value>] extends [never]
    ? unknown
    : [NonNullable<Value>] extends [SourceUrl]
      ? "url"
      : NonNullable<Value> extends readonly (infer Item)[]
        ? { readonly items: MetadataUrlSchema<Item> }
        : NonNullable<Value> extends object
          ? keyof NonNullable<Value> extends never
            ? never
            : {
                readonly [Key in keyof NonNullable<Value>]?: MetadataUrlSchema<
                  NonNullable<Value>[Key]
                >;
              }
          : never;

type UrlDiagnostic = { address: string; reason: MetadataUrlDefect["reason"] };
const readDiagnostics = (value: unknown): UrlDiagnostic[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const diagnostics: UrlDiagnostic[] = [];
  for (const entry of value) {
    if (
      isRecord(entry) &&
      typeof entry["address"] === "string" &&
      typeof entry["reason"] === "string" &&
      includes(METADATA_URL_DEFECT_REASONS, entry["reason"])
    ) {
      diagnostics.push({ address: entry["address"], reason: entry["reason"] });
    }
  }
  return diagnostics;
};
const mergeDiagnostics = (first: unknown, second: unknown) => {
  const entries = new Map<string, UrlDiagnostic>();
  for (const diagnostic of [
    ...readDiagnostics(first),
    ...readDiagnostics(second),
  ]) {
    entries.set(JSON.stringify(diagnostic), diagnostic);
  }
  return [...entries.values()];
};

const declarationSymbol = Symbol("MetadataUrlDeclaration");
class MetadataUrlDeclaration {
  readonly keys: ReadonlySet<string>;
  readonly schema: unknown;

  constructor(keys: ReadonlySet<string>, schema: unknown) {
    this.keys = keys;
    this.schema = schema;
  }
}

const declarationOf = (container: unknown) => {
  if (typeof container !== "object" || container === null) {
    return undefined;
  }
  const declaration: unknown = Object.getOwnPropertyDescriptor(
    container,
    declarationSymbol,
  )?.value;
  return declaration instanceof MetadataUrlDeclaration
    ? declaration
    : undefined;
};

/** Only explicit producer declarations authorize a scalar URL to bypass display-text projection. */
export const metadataUrlKeys = (container: unknown): ReadonlySet<string> =>
  declarationOf(container)?.keys ?? new Set<string>();

export const approvedMetadataUrl = (
  container: unknown,
  key: string,
): SafeHref | undefined => {
  if (
    !metadataUrlKeys(container).has(key) ||
    typeof container !== "object" ||
    container === null
  ) {
    return undefined;
  }
  const value: unknown = Reflect.get(container, key);
  if (typeof value !== "string") {
    return panic("Declared metadata URL must remain a scalar string");
  }
  const approved = toMetadataUrl(value, "decoded");
  if (approved === undefined || approved instanceof MetadataUrlDefect) {
    return panic("Declared metadata URL changed after approval");
  }
  return approved;
};

const mark = <Container extends object>(
  container: Container,
  keys: ReadonlySet<string>,
  schema: unknown,
) => {
  Object.defineProperty(container, declarationSymbol, {
    value: new MetadataUrlDeclaration(keys, schema),
    configurable: true,
    enumerable: false,
  });
  return container;
};

/** Storage clones retain exact declarations only while every approved scalar is unchanged. */
export const preserveMetadataUrlDeclarations = <Container extends object>(
  source: unknown,
  target: Container,
) => {
  const declaration = declarationOf(source);
  if (declaration === undefined) {
    return target;
  }
  const keys = new Set(metadataUrlKeys(target));
  for (const key of declaration.keys) {
    if (typeof source !== "object" || source === null) {
      return panic("Metadata declaration lost its container");
    }
    if (Reflect.get(source, key) !== Reflect.get(target, key)) {
      // A fresh producer may intentionally replace a replayed subtree, but
      // its independently approved target declaration must own that scalar.
      if (keys.has(key) && approvedMetadataUrl(target, key) !== undefined) {
        continue;
      }
      return panic("Approved metadata URL changed during metadata copying");
    }
    keys.add(key);
  }
  if (typeof source === "object" && source !== null) {
    for (const key of Object.keys(source)) {
      const sourceChild: unknown = Reflect.get(source, key);
      const targetChild: unknown = Reflect.get(target, key);
      if (
        typeof sourceChild === "object" &&
        sourceChild !== null &&
        typeof targetChild === "object" &&
        targetChild !== null
      ) {
        preserveMetadataUrlDeclarations(sourceChild, targetChild);
      }
    }
  }
  const targetDeclaration = declarationOf(target);
  const schema =
    isRecord(declaration.schema) && isRecord(targetDeclaration?.schema)
      ? { ...declaration.schema, ...targetDeclaration.schema }
      : declaration.schema;
  if (isRecord(source)) {
    const diagnostics = mergeDiagnostics(
      source[META_URL_DIAGNOSTICS],
      Reflect.get(target, META_URL_DIAGNOSTICS),
    );
    if (diagnostics.length > 0) {
      Reflect.set(target, META_URL_DIAGNOSTICS, diagnostics);
    }
  }
  return mark(target, keys, schema);
};

type ProjectionOptions = {
  value: unknown;
  schema: unknown;
  address: string;
  diagnostics: UrlDiagnostic[];
};
const project = ({
  value,
  schema,
  address,
  diagnostics,
}: ProjectionOptions): unknown => {
  if (schema === "url") {
    if (value === undefined || value === null) {
      return undefined;
    }
    let url: SourceUrl;
    if (value instanceof MetadataUrlDefect) {
      url = value;
    } else if (typeof value === "string") {
      url = toMetadataUrl(value, "decoded");
    } else {
      url = new MetadataUrlDefect({
        message: "Metadata URL must be a scalar string",
        reason: "unsupported-url-value",
      });
    }
    if (url instanceof MetadataUrlDefect) {
      diagnostics.push({ address, reason: url.reason });
      return undefined;
    }
    return url;
  }
  if (value === undefined || value === null) {
    return value;
  }
  if (!isRecord(schema)) {
    return panic("Metadata URL declaration must be an explicit schema");
  }
  if (Object.keys(schema).length === 1 && Object.hasOwn(schema, "items")) {
    if (!Array.isArray(value)) {
      return panic(
        "Metadata URL array declaration does not match its producer",
      );
    }
    const keys = new Set<string>();
    const projected = value.map((entry: unknown, index) => {
      const item = project({
        value: entry,
        schema: schema["items"],
        address: `${address}[${index}]`,
        diagnostics,
      });
      if (schema["items"] === "url" && typeof item === "string") {
        keys.add(String(index));
      }
      return item === undefined ? null : item;
    });
    return mark(projected, keys, schema);
  }
  if (!isRecord(value)) {
    return panic("Metadata URL object declaration does not match its producer");
  }
  const projected = new Map(Object.entries(value));
  const keys = new Set<string>();
  for (const [key, childSchema] of Object.entries(schema)) {
    if (childSchema === undefined) {
      continue;
    }
    const child = project({
      value: value[key],
      schema: childSchema,
      address: address === "" ? key : `${address}.${key}`,
      diagnostics,
    });
    if (child === undefined) {
      projected.delete(key);
    } else {
      projected.set(key, child);
      if (childSchema === "url" && typeof child === "string") {
        keys.add(key);
      }
    }
  }
  return mark(Object.fromEntries(projected), keys, schema);
};

const projectMetadata = (metadata: unknown, schema: unknown) => {
  const diagnostics: UrlDiagnostic[] = [];
  const projected = project({
    value: metadata,
    schema,
    address: "",
    diagnostics,
  });
  if (!isRecord(projected)) {
    return panic("Metadata URL contract requires an object root");
  }
  if (diagnostics.length > 0) {
    projected[META_URL_DIAGNOSTICS] = mergeDiagnostics(
      projected[META_URL_DIAGNOSTICS],
      diagnostics,
    );
  }
  return projected;
};

/** Source producers must construct every declared leaf before this boundary. */
export const approveMetadataUrls = <Metadata extends Record<string, unknown>>(
  metadata: Metadata,
  schema: MetadataUrlSchema<NoInfer<Metadata>>,
) => projectMetadata(metadata, schema);

/** Reload uses the producer's contract, validating persisted scalars without decoding entities again. */
export const rehydrateMetadataUrls = (metadata: unknown, schema: unknown) =>
  projectMetadata(metadata, schema);

/** Contract addresses remain available for empty arrays and absent optional leaves. */
export const metadataUrlAddresses = (metadata: unknown): readonly string[] => {
  const addresses: string[] = [];
  const visit = (schema: unknown, address: string) => {
    if (schema === "url") {
      addresses.push(address);
      return;
    }
    if (!isRecord(schema)) {
      return;
    }
    if (Object.keys(schema).length === 1 && Object.hasOwn(schema, "items")) {
      visit(schema["items"], `${address}[*]`);
      return;
    }
    for (const [key, child] of Object.entries(schema)) {
      visit(child, address === "" ? key : `${address}.${key}`);
    }
  };
  visit(declarationOf(metadata)?.schema, "");
  return addresses;
};
