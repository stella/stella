// parser-output-unchanged: adds explicit URL declarations; unannotated metadata and existing stored output are unchanged
import { panic } from "better-result";

import {
  METADATA_URL_DEFECT_REASONS,
  MetadataUrlDefect,
  toMetadataUrl,
  type SafeHref,
} from "@/api/lib/sanitize-url";
import { includes, isRecord } from "@/api/lib/type-guards";

export const META_URL_DIAGNOSTICS = "metadataUrlDiagnostics";
export const MAX_METADATA_URL_DIAGNOSTICS = 64;
const MAX_DIAGNOSTIC_ADDRESS_LENGTH = 256;

type ConstructedUrl = SafeHref | MetadataUrlDefect;

/** An explicit transient source branch preserves publisher JSON outside the validated object shape. */
export const opaqueMetadataValue = (value: unknown) =>
  ({ type: "metadata-url-opaque", value }) as const;
type OpaqueMetadataValue = ReturnType<typeof opaqueMetadataValue>;
type UrlBranches<Value> = Value extends ConstructedUrl
  ? true
  : Value extends OpaqueMetadataValue
    ? false
    : Value extends readonly (infer Item)[]
      ? ContainsUrls<Item>
      : Value extends object
        ? true extends {
            [Key in keyof Value]: ContainsUrls<Value[Key]>;
          }[keyof Value]
          ? true
          : false
        : false;
type ContainsUrls<Value> = unknown extends Value
  ? false
  : true extends UrlBranches<NonNullable<Value>>
    ? true
    : false;
type ObjectUrlSchema<Value> = {
  readonly [
    Key in keyof Value as ContainsUrls<Value[Key]> extends true ? Key : never
  ]-?: MetadataUrlSchema<Value[Key]>;
} & {
  readonly [
    Key in keyof Value as ContainsUrls<Value[Key]> extends true ? never : Key
  ]?: MetadataUrlSchema<Value[Key]>;
};

/** Constructed URL branches require a declaration; display strings never imply one. */
export type MetadataUrlSchema<Value> = unknown extends Value
  ? never
  : [NonNullable<Value>] extends [never]
    ? unknown
    : [NonNullable<Value>] extends [ConstructedUrl]
      ? "url"
      : [Extract<NonNullable<Value>, OpaqueMetadataValue>] extends [never]
        ? NonNullable<Value> extends readonly (infer Item)[]
          ? [NonNullable<Item>] extends [never]
            ? { readonly items: unknown }
            : [NonNullable<Item>] extends [ConstructedUrl]
              ? never
              : { readonly items: MetadataUrlSchema<Item> }
          : [Extract<NonNullable<Value>, object>] extends [never]
            ? never
            : [Extract<NonNullable<Value>, string>] extends [never]
              ? ObjectUrlSchema<Extract<NonNullable<Value>, object>>
              : {
                  readonly object: ObjectUrlSchema<
                    Extract<NonNullable<Value>, object>
                  >;
                  readonly preserve: "string";
                }
        : {
            readonly object: MetadataUrlSchema<
              Exclude<NonNullable<Value>, OpaqueMetadataValue>
            >;
            readonly preserve: "opaque";
          };

type UrlDiagnostic = { address: string; reason: MetadataUrlDefect["reason"] };
type DiagnosticState = {
  entries: UrlDiagnostic[];
  overflow: number;
  present: Set<string>;
};
const recordDefect = (state: DiagnosticState, diagnostic: UrlDiagnostic) => {
  if (
    state.entries.some(
      (entry) =>
        entry.address === diagnostic.address &&
        entry.reason === diagnostic.reason,
    )
  ) {
    return;
  }
  if (state.entries.length < MAX_METADATA_URL_DIAGNOSTICS) {
    state.entries.push(diagnostic);
  } else {
    state.overflow += 1;
  }
};
const readDiagnostics = (value: unknown): UrlDiagnostic[] => {
  if (!isRecord(value) || !Array.isArray(value["entries"])) {
    return [];
  }
  const diagnostics: UrlDiagnostic[] = [];
  for (const entry of value["entries"]) {
    if (diagnostics.length === MAX_METADATA_URL_DIAGNOSTICS) {
      break;
    }
    if (
      isRecord(entry) &&
      typeof entry["address"] === "string" &&
      entry["address"].length <= MAX_DIAGNOSTIC_ADDRESS_LENGTH &&
      typeof entry["reason"] === "string" &&
      includes(METADATA_URL_DEFECT_REASONS, entry["reason"])
    ) {
      diagnostics.push({ address: entry["address"], reason: entry["reason"] });
    }
  }
  return diagnostics;
};

/** Schema introspection is independent of object identity, copies, and storage. */
export const metadataUrlKeys = (schema: unknown): ReadonlySet<string> =>
  new Set(
    isRecord(schema)
      ? Object.entries(schema)
          .filter(([, child]) => child === "url")
          .map(([key]) => key)
      : [],
  );

export const metadataUrlChildSchema = (
  schema: unknown,
  key: string,
): unknown => {
  if (!isRecord(schema)) {
    return undefined;
  }
  if (
    (schema["preserve"] === "string" || schema["preserve"] === "opaque") &&
    isRecord(schema["object"])
  ) {
    return schema["object"][key];
  }
  return schema[key];
};
export const metadataUrlItemSchema = (schema: unknown): unknown =>
  isRecord(schema) ? schema["items"] : undefined;

/** Contract addresses also cover absent leaves and empty arrays. */
export const metadataUrlAddresses = (schema: unknown): readonly string[] => {
  const addresses: string[] = [];
  const visit = (node: unknown, address: string) => {
    if (node === "url") {
      addresses.push(address);
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    if (Object.hasOwn(node, "items")) {
      visit(node["items"], `${address}[*]`);
      return;
    }
    if (node["preserve"] === "string" || node["preserve"] === "opaque") {
      visit(node["object"], address);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      visit(child, address === "" ? key : `${address}.${key}`);
    }
  };
  visit(schema, "");
  return addresses;
};

type ProjectionOptions = {
  value: unknown;
  schema: unknown;
  address: string;
  diagnostics: DiagnosticState;
  mode: "source" | "stored";
};
type UrlProjectionOptions = Pick<
  ProjectionOptions,
  "value" | "address" | "diagnostics"
>;

const projectUrl = ({ value, address, diagnostics }: UrlProjectionOptions) => {
  if (value !== undefined) {
    diagnostics.present.add(address);
  }
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "string" && !(value instanceof MetadataUrlDefect)) {
    recordDefect(diagnostics, { address, reason: "unsupported-url-value" });
    return undefined;
  }
  const url =
    value instanceof MetadataUrlDefect
      ? value
      : toMetadataUrl(value, "decoded");
  if (url instanceof MetadataUrlDefect) {
    recordDefect(diagnostics, { address, reason: url.reason });
    return undefined;
  }
  return url;
};

const project = ({
  value,
  schema,
  address,
  diagnostics,
  mode,
}: ProjectionOptions): unknown => {
  if (schema === "url") {
    return projectUrl({ value, address, diagnostics });
  }
  if (value === undefined || value === null) {
    return value;
  }
  if (!isRecord(schema)) {
    return panic("Metadata URL declaration must be an explicit schema");
  }
  if (schema["preserve"] === "opaque") {
    const unwrapped =
      mode === "source" &&
      isRecord(value) &&
      value["type"] === "metadata-url-opaque" &&
      Object.hasOwn(value, "value")
        ? value["value"]
        : value;
    if (!isRecord(unwrapped)) {
      return unwrapped;
    }
    return project({
      value: unwrapped,
      schema: schema["object"],
      address,
      diagnostics,
      mode,
    });
  }
  if (schema["preserve"] === "string" && typeof value === "string") {
    return value;
  }
  if (schema["preserve"] === "string") {
    return project({
      value,
      schema: schema["object"],
      address,
      diagnostics,
      mode,
    });
  }
  if (Object.hasOwn(schema, "items")) {
    if (schema["items"] === "url") {
      return panic("Scalar URL arrays have no metadata schema contract");
    }
    if (!Array.isArray(value)) {
      recordDefect(diagnostics, { address, reason: "unsupported-url-value" });
      return undefined;
    }
    const projected: unknown[] = [];
    for (const [index, entry] of value.entries()) {
      const item = project({
        value: entry,
        schema: schema["items"],
        address: `${address}[${index}]`,
        diagnostics,
        mode,
      });
      projected.push(item === undefined ? null : item);
    }
    return projected;
  }
  if (!isRecord(value)) {
    recordDefect(diagnostics, { address, reason: "unsupported-url-value" });
    return undefined;
  }
  const projected = new Map(Object.entries(value));
  for (const [key, childSchema] of Object.entries(schema)) {
    if (childSchema === undefined) {
      continue;
    }
    const child = project({
      value: value[key],
      schema: childSchema,
      address: address === "" ? key : `${address}.${key}`,
      diagnostics,
      mode,
    });
    if (child === undefined) {
      projected.delete(key);
    } else {
      projected.set(key, child);
    }
  }
  return Object.fromEntries(projected);
};

const projectMetadata = (
  metadata: unknown,
  schema: unknown,
  mode: "source" | "stored",
) => {
  const diagnostics: DiagnosticState = {
    entries: [],
    overflow: 0,
    present: new Set(),
  };
  const projected = project({
    value: metadata,
    schema,
    address: "",
    diagnostics,
    mode,
  });
  if (!isRecord(projected)) {
    return {
      [META_URL_DIAGNOSTICS]: {
        entries: [{ address: "", reason: "unsupported-url-value" }],
        overflowCount: 0,
      },
    };
  }
  const previous =
    mode === "stored" ? readDiagnostics(projected[META_URL_DIAGNOSTICS]) : [];
  delete projected.metadataUrlDiagnostics;
  const storedSidecar =
    mode === "stored" && isRecord(metadata)
      ? metadata[META_URL_DIAGNOSTICS]
      : undefined;
  const priorOverflow: unknown =
    isRecord(storedSidecar) && Array.isArray(storedSidecar["entries"])
      ? storedSidecar["overflowCount"]
      : undefined;
  // Persisted omissions retain their bounded diagnostic snapshot; a current value supersedes it.
  for (const diagnostic of previous) {
    if (!diagnostics.present.has(diagnostic.address)) {
      recordDefect(diagnostics, diagnostic);
    }
  }
  if (
    mode === "stored" &&
    typeof priorOverflow === "number" &&
    Number.isSafeInteger(priorOverflow) &&
    priorOverflow > 0
  ) {
    diagnostics.overflow = Math.min(
      Number.MAX_SAFE_INTEGER,
      diagnostics.overflow + priorOverflow,
    );
  }
  if (diagnostics.entries.length > 0 || diagnostics.overflow > 0) {
    projected[META_URL_DIAGNOSTICS] = {
      entries: diagnostics.entries,
      overflowCount: diagnostics.overflow,
    };
  }
  return projected;
};

/** Fresh producers derive diagnostics from their current constructed leaves only. */
export const approveMetadataUrls = <Metadata extends Record<string, unknown>>(
  metadata: Metadata,
  schema: NoInfer<MetadataUrlSchema<Metadata>>,
) => projectMetadata(metadata, schema, "source");

/** Stored URL strings are validated without entity decoding or dependence on hidden state. */
export const rehydrateMetadataUrls = (metadata: unknown, schema: unknown) =>
  projectMetadata(metadata, schema, "stored");
