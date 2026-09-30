import { panic, Result, TaggedError } from "better-result";
import * as cheerio from "cheerio";
import { type AnyNode, isTag } from "domhandler";

import {
  decodeSourceRawEnvelope,
  decodeSourceRawEnvelopeObjects,
  LEGACY_RAW_SHAPES,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  type LegacyRawShape,
  type SourceRawObjectRef,
  type SourceRawObjects,
  type SourceRawParts,
  type StoredRawReader,
} from "@/api/lib/legal-search/ingestion-types";
import { isRecord } from "@/api/lib/type-guards";

import { readTextBaseline } from "./oracle";
import {
  ADAPTER_SOURCE_FORMATS,
  COURTLISTENER_TEXT_FORMATS,
  IMPORT_SOURCE_FORMATS,
  type SourceFormat,
} from "./source-formats";
import {
  TEXT_FORMAT,
  TEXT_ORACLE_LIMITS,
  TextOracleError,
  type TextBaseline,
} from "./types";

const SOURCE_FORMATS = {
  ...ADAPTER_SOURCE_FORMATS,
  ...IMPORT_SOURCE_FORMATS,
};
export type SourceKey = keyof typeof SOURCE_FORMATS;

export class SourceInputError extends TaggedError("SourceInputError")<{
  message: string;
  reason: "unavailable" | "malformed" | "unsupported" | "resource_limit";
  cause?: unknown;
}>() {}

type SourceFailure = SourceInputError | TextOracleError;
type BaselineResult = Result<TextBaseline, SourceFailure>;
type SourceBranch = SourceFormat["branches"][number];
const inputFailure = (reason: SourceInputError["reason"], message: string) =>
  Result.err(new SourceInputError({ reason, message }));

const LEGACY_SHAPES_BY_SOURCE = new Map<string, readonly LegacyRawShape[]>(
  Object.entries(LEGACY_RAW_SHAPES),
);

type DecodedSource = {
  parts: SourceRawParts;
  objects: SourceRawObjects;
  directObjects: ReadonlyMap<string, Uint8Array>;
};
type DecodeSourceOptions = {
  raw: Uint8Array;
  contentType: string | null;
  sourceKey: SourceKey;
  format: SourceFormat;
};

const decodeSource = ({
  raw,
  contentType,
  sourceKey,
  format,
}: DecodeSourceOptions): Result<DecodedSource, SourceInputError> => {
  if (raw.byteLength > TEXT_ORACLE_LIMITS.rawBytes) {
    return inputFailure(
      "resource_limit",
      "Captured source exceeds the byte limit",
    );
  }
  const legacy = LEGACY_SHAPES_BY_SOURCE.get(sourceKey) ?? [];
  const directPart = format.branches.find(
    ({ recipe }) =>
      recipe.type === "object" &&
      recipe.directContentType !== undefined &&
      recipe.directContentType === contentType,
  )?.recipe.part;
  const legacyBinary = legacy.find(
    (shape) =>
      shape.shape === "document-bytes" &&
      shape.contentTypes.includes(contentType),
  );
  const binaryPart =
    directPart ??
    (legacyBinary?.shape === "document-bytes" ? legacyBinary.part : undefined);
  if (binaryPart !== undefined) {
    return Result.ok({
      parts: {},
      objects: {},
      directObjects: new Map([[binaryPart, raw]]),
    });
  }
  const decoded = Result.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(raw),
    catch: (cause) =>
      new SourceInputError({
        reason: "malformed",
        message: "Captured source is not valid UTF-8",
        cause,
      }),
  });
  if (decoded.isErr()) {
    return decoded;
  }
  const text = decoded.value;
  const parts = decodeSourceRawEnvelope(text);
  if (parts !== null) {
    const objects = decodeSourceRawEnvelopeObjects(text);
    // The owner decoder treats malformed object maps as absent; verification must distinguish them.
    const parsed = Result.try({
      try: (): unknown => JSON.parse(text),
      catch: (cause) =>
        new SourceInputError({
          reason: "malformed",
          message: "Captured envelope cannot be decoded",
          cause,
        }),
    });
    if (parsed.isErr()) {
      return parsed;
    }
    if (isRecord(parsed.value) && Object.hasOwn(parsed.value, "objects")) {
      const capturedObjects = parsed.value["objects"];
      if (
        !isRecord(capturedObjects) ||
        Object.keys(capturedObjects).length !== Object.keys(objects).length
      ) {
        return inputFailure(
          "malformed",
          "Captured envelope has invalid object references",
        );
      }
    }
    if (
      Object.keys(parts).length + Object.keys(objects).length >
      TEXT_ORACLE_LIMITS.nodes
    ) {
      return inputFailure(
        "resource_limit",
        "Captured envelope exceeds the part limit",
      );
    }
    return Result.ok({ parts, objects, directObjects: new Map() });
  }
  if (contentType === SOURCE_RAW_ENVELOPE_CONTENT_TYPE) {
    return inputFailure(
      "malformed",
      "Captured source is not a valid raw envelope",
    );
  }
  for (const shape of legacy) {
    if (!shape.contentTypes.includes(contentType)) {
      continue;
    }
    const shapeKind = shape.shape;
    switch (shapeKind) {
      case "bare-payload":
        return Result.ok({
          parts: { [shape.part]: text },
          objects: {},
          directObjects: new Map(),
        });
      case "wrapper-json": {
        const parsed = Result.try({
          try: (): unknown => JSON.parse(text),
          catch: (cause) =>
            new SourceInputError({
              reason: "malformed",
              message: "Legacy source wrapper cannot be decoded",
              cause,
            }),
        });
        if (parsed.isErr()) {
          return parsed;
        }
        if (!isRecord(parsed.value)) {
          return inputFailure(
            "malformed",
            "Legacy source wrapper is not an object",
          );
        }
        const legacyParts: Record<string, string> = {};
        for (const [key, part] of Object.entries(shape.keys)) {
          const value = parsed.value[key];
          if (value === undefined || value === null) {
            continue;
          }
          // Some historical wrappers kept publisher JSON as an object, not a JSON string.
          legacyParts[part] =
            typeof value === "string" ? value : JSON.stringify(value);
        }
        return Result.ok({
          parts: legacyParts,
          objects: {},
          directObjects: new Map(),
        });
      }
      case "document-bytes":
        return panic(
          "Legacy binary should have been selected before UTF-8 decoding",
        );
      default:
        shapeKind satisfies never;
        return panic("Unhandled legacy source shape");
    }
  }
  return inputFailure(
    "unsupported",
    "Captured source has no declared transport shape",
  );
};

type SourceBudget = { nodes: number; bytes: number; cacheBytes: number };
type JsonPathOptions = {
  value: unknown;
  path: readonly string[];
  budget: SourceBudget;
};
/** Missing/null optional fields are absent; a partly malformed array cannot lose its good rows. */
const jsonPath = ({
  value,
  path,
  budget,
}: JsonPathOptions): Result<unknown[], SourceInputError> => {
  if (path.length === 0 || path.length > TEXT_ORACLE_LIMITS.depth) {
    return inputFailure(
      "malformed",
      "Source text path must be bounded and nonempty",
    );
  }
  let values: unknown[] = [value];
  for (const segment of path) {
    const children: unknown[] = [];
    let absent = 0;
    for (const current of values) {
      budget.nodes += 1;
      if (budget.nodes > TEXT_ORACLE_LIMITS.nodes) {
        return inputFailure(
          "resource_limit",
          "Source path traversal exceeds the node limit",
        );
      }
      if (current === undefined || current === null) {
        absent += 1;
        continue;
      }
      if (segment === "*") {
        if (!Array.isArray(current)) {
          return inputFailure(
            "malformed",
            "Source text path expected an array",
          );
        }
        if (current.length + budget.nodes > TEXT_ORACLE_LIMITS.nodes) {
          return inputFailure(
            "resource_limit",
            "Source array exceeds the node limit",
          );
        }
        for (const child of current) {
          children.push(child);
        }
        continue;
      }
      if (!isRecord(current)) {
        return inputFailure("malformed", "Source text path expected an object");
      }
      if (!Object.hasOwn(current, segment) || current[segment] === null) {
        absent += 1;
        continue;
      }
      children.push(current[segment]);
    }
    if (absent > 0 && children.length > 0) {
      return inputFailure(
        "malformed",
        "Source text path is missing from some array rows",
      );
    }
    values = children;
  }
  return Result.ok(values);
};

const parseJson = (text: string) =>
  Result.try({
    try: (): unknown => JSON.parse(text),
    catch: (cause) =>
      new SourceInputError({
        reason: "malformed",
        message: "Captured JSON part cannot be decoded",
        cause,
      }),
  });

const decodeBase64 = (text: string): Result<Uint8Array, SourceInputError> => {
  if (
    text.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      text,
    )
  ) {
    return inputFailure("malformed", "Captured binary is not canonical base64");
  }
  if ((text.length / 4) * 3 > TEXT_ORACLE_LIMITS.rawBytes) {
    return inputFailure(
      "resource_limit",
      "Captured base64 exceeds the byte limit",
    );
  }
  const raw = new Uint8Array(Buffer.from(text, "base64"));
  if (Buffer.from(raw).toString("base64") !== text) {
    return inputFailure(
      "malformed",
      "Captured base64 has invalid padding bits",
    );
  }
  return Result.ok(raw);
};

type ReadResolvedBytesOptions = { branch: SourceBranch; raw: Uint8Array };
const readResolvedBytes = async ({
  branch,
  raw,
}: ReadResolvedBytesOptions): Promise<BaselineResult> => {
  const formatKind = branch.format;
  switch (formatKind) {
    case TEXT_FORMAT.XML:
      return await readTextBaseline({
        format: branch.format,
        xmlDialect: branch.xmlDialect,
        raw,
      });
    case TEXT_FORMAT.HTML:
    case TEXT_FORMAT.TEXT:
    case TEXT_FORMAT.DOCX:
    case TEXT_FORMAT.PDF:
    case TEXT_FORMAT.RTF:
      return await readTextBaseline({ format: branch.format, raw });
    case TEXT_FORMAT.JSON:
      return inputFailure(
        "unsupported",
        "JSON transport requires declared text fields",
      );
    default:
      formatKind satisfies never;
      return panic("Unhandled captured text format");
  }
};

type BranchResult = Result<TextBaseline | null, SourceFailure>;
type ReadCapturedBinaryOptions = {
  ref: SourceRawObjectRef;
  readBinary?: StoredRawReader;
};
/** Shared verified boundary for parser replay and the independent source baseline. */
export const readCapturedBinary = async ({
  ref,
  readBinary,
}: ReadCapturedBinaryOptions): Promise<
  Result<Uint8Array, SourceInputError>
> => {
  if (
    !Number.isSafeInteger(ref.byteLength) ||
    ref.byteLength < 0 ||
    !/^[0-9a-f]{64}$/u.test(ref.sha256) ||
    ref.location.trim() === "" ||
    ref.contentType.trim() === ""
  ) {
    return inputFailure("malformed", "Captured binary reference is invalid");
  }
  if (ref.byteLength > TEXT_ORACLE_LIMITS.rawBytes) {
    return inputFailure(
      "resource_limit",
      "Captured binary exceeds the byte limit",
    );
  }
  if (readBinary === undefined) {
    return inputFailure(
      "unavailable",
      "Captured binary needs an injected stored-object reader",
    );
  }
  const read = await Result.tryPromise({
    try: () => readBinary(ref.location),
    catch: (cause) =>
      new SourceInputError({
        reason: "unavailable",
        message: "Captured binary read failed",
        cause,
      }),
  });
  if (read.isErr()) {
    return read;
  }
  if (read.value === null) {
    return inputFailure("unavailable", "Captured binary object is missing");
  }
  if (
    read.value.byteLength !== ref.byteLength ||
    new Bun.CryptoHasher("sha256").update(read.value).digest("hex") !==
      ref.sha256
  ) {
    return inputFailure(
      "malformed",
      "Captured binary does not match its source reference",
    );
  }
  return Result.ok(read.value);
};

type ReadBranchOptions = {
  branch: SourceBranch;
  format: SourceFormat;
  source: DecodedSource;
  budget: SourceBudget;
  cache: Map<string, Uint8Array>;
  readBinary: StoredRawReader | undefined;
};

const readOpinions = async ({
  text,
  format,
  budget,
}: {
  text: string;
  format: SourceFormat;
  budget: SourceBudget;
}): Promise<BaselineResult> => {
  const parsed = parseJson(text);
  if (parsed.isErr()) {
    return parsed;
  }
  if (!Array.isArray(parsed.value)) {
    return inputFailure("malformed", "Captured opinions must be an array");
  }
  if (parsed.value.length > TEXT_ORACLE_LIMITS.nodes) {
    return inputFailure(
      "resource_limit",
      "Opinion collection exceeds the node limit",
    );
  }
  const texts: string[] = [];
  let characters = 0;
  for (const row of parsed.value) {
    budget.nodes += 1;
    if (budget.nodes > TEXT_ORACLE_LIMITS.nodes) {
      return inputFailure(
        "resource_limit",
        "Opinion collection exceeds the node limit",
      );
    }
    if (!isRecord(row)) {
      return inputFailure("malformed", "Captured opinion is not an object");
    }
    let selected: {
      column: (typeof COURTLISTENER_TEXT_FORMATS)[number];
      text: string;
    } | null = null;
    for (const column of COURTLISTENER_TEXT_FORMATS) {
      const value = row[column];
      if (typeof value !== "string") {
        return inputFailure(
          "malformed",
          "Captured opinion is missing a text column",
        );
      }
      if (selected === null && value.trim() !== "") {
        selected = { column, text: value };
      }
    }
    if (selected === null) {
      return typeof row["xml_scan"] === "string" &&
        row["xml_scan"].trim() !== ""
        ? inputFailure(
            "unsupported",
            "Opinion scan layout requires external page assets",
          )
        : inputFailure(
            "unavailable",
            "Captured opinion has no usable text candidate",
          );
    }
    const head = selected.text
      .replace(/^\uFEFF?\s*<\?xml\s[^?]*\?>/u, "")
      .trimStart();
    let selectedFormat:
      | typeof TEXT_FORMAT.TEXT
      | typeof TEXT_FORMAT.XML
      | typeof TEXT_FORMAT.HTML;
    if (selected.column === "plain_text") {
      selectedFormat = TEXT_FORMAT.TEXT;
    } else if (
      selected.column === "xml_harvard" ||
      /^<opinion[\s>/]/u.test(head)
    ) {
      selectedFormat = TEXT_FORMAT.XML;
    } else {
      selectedFormat = TEXT_FORMAT.HTML;
    }
    const branch = format.branches.find(
      (candidate) => candidate.format === selectedFormat,
    );
    if (branch === undefined) {
      return inputFailure(
        "unsupported",
        "Selected opinion format is not declared by the source",
      );
    }
    const baseline = await readResolvedBytes({
      branch,
      raw: new TextEncoder().encode(selected.text),
    });
    if (baseline.isErr()) {
      return baseline;
    }
    characters += baseline.value.text.length + 1;
    if (characters > TEXT_ORACLE_LIMITS.textCharacters) {
      return inputFailure(
        "resource_limit",
        "Opinion text exceeds the character limit",
      );
    }
    if (baseline.value.text.trim() === "") {
      return inputFailure(
        "unavailable",
        "Selected opinion candidate has no visible text",
      );
    }
    texts.push(baseline.value.text);
  }
  if (texts.length === 0) {
    return inputFailure("unavailable", "Captured opinion collection is empty");
  }
  return Result.ok({ text: texts.join("\n") });
};

type ReadHtmlInputOptions = {
  branch: SourceBranch;
  recipe: Extract<SourceBranch["recipe"], { type: "html-input" }>;
  part: string | undefined;
  budget: SourceBudget;
};
const readHtmlInput = async ({
  branch,
  recipe,
  part,
  budget,
}: ReadHtmlInputOptions): Promise<BranchResult> => {
  if (part === undefined) {
    return Result.ok(null);
  }
  const $ = cheerio.load(part);
  const stack: AnyNode[] = [...$.root().contents().toArray()];
  const values: string[] = [];
  while (stack.length > 0) {
    const node = stack.pop() ?? panic("Transport walk stack is not empty");
    budget.nodes += 1;
    if (budget.nodes > TEXT_ORACLE_LIMITS.nodes) {
      return inputFailure(
        "resource_limit",
        "HTML transport exceeds the node limit",
      );
    }
    if (
      isTag(node) &&
      node.name === "input" &&
      node.attribs["id"] === recipe.id
    ) {
      const value = node.attribs[recipe.attribute];
      if (value !== undefined && value.trim() !== "") {
        values.push(value);
      }
    }
    if ("children" in node) {
      for (const child of node.children) {
        stack.push(child);
      }
    }
  }
  if (values.length === 0) {
    return Result.ok(null);
  }
  if (values.length !== 1) {
    return inputFailure(
      "malformed",
      "Captured HTML contains duplicate decision inputs",
    );
  }
  return await readResolvedBytes({
    branch,
    raw: new TextEncoder().encode(
      values.at(0) ?? panic("One captured decision input exists"),
    ),
  });
};

type ReadEnvelopeBase64Options = {
  branch: SourceBranch;
  recipe: Extract<SourceBranch["recipe"], { type: "envelope-base64" }>;
  part: string | undefined;
  source: DecodedSource;
};
const readEnvelopeBase64 = async ({
  branch,
  recipe,
  part,
  source,
}: ReadEnvelopeBase64Options): Promise<BranchResult> => {
  if (part === undefined) {
    return Result.ok(null);
  }
  const contentType = source.parts[recipe.contentTypePart];
  if (contentType === undefined) {
    return inputFailure(
      "malformed",
      "Captured base64 is missing its declared content type",
    );
  }
  if (contentType !== recipe.contentType) {
    return Result.ok(null);
  }
  const decoded = decodeBase64(part);
  return decoded.isErr()
    ? decoded
    : await readResolvedBytes({ branch, raw: decoded.value });
};

type ReadJsonBase64Options = {
  branch: SourceBranch;
  recipe: Extract<SourceBranch["recipe"], { type: "json-base64" }>;
  part: string | undefined;
  budget: SourceBudget;
};
const readJsonBase64 = async ({
  branch,
  recipe,
  part,
  budget,
}: ReadJsonBase64Options): Promise<BranchResult> => {
  if (part === undefined) {
    return Result.ok(null);
  }
  const parsed = parseJson(part);
  if (parsed.isErr()) {
    return parsed;
  }
  const values = jsonPath({
    value: parsed.value,
    path: recipe.path,
    budget,
  });
  if (values.isErr()) {
    return values;
  }
  if (values.value.length !== 1 || typeof values.value.at(0) !== "string") {
    return inputFailure(
      "malformed",
      "Captured JSON binary field is missing or ambiguous",
    );
  }
  const value = values.value.at(0);
  if (typeof value !== "string") {
    return panic("Captured binary value was narrowed to a string");
  }
  const decoded = decodeBase64(value);
  return decoded.isErr()
    ? decoded
    : await readResolvedBytes({ branch, raw: decoded.value });
};

type ReadJsonFieldsOptions = {
  recipe: Extract<SourceBranch["recipe"], { type: "json-text" }>;
  part: string | undefined;
  budget: SourceBudget;
};
const readJsonFields = async ({
  recipe,
  part,
  budget,
}: ReadJsonFieldsOptions): Promise<BranchResult> => {
  if (part === undefined) {
    return Result.ok(null);
  }
  const parsed = parseJson(part);
  if (parsed.isErr()) {
    return parsed;
  }
  for (const paths of recipe.alternatives) {
    const fields: {
      path: readonly string[];
      format: typeof recipe.textFormat;
    }[] = [];
    let nonempty = false;
    for (const path of paths) {
      const values = jsonPath({ value: parsed.value, path, budget });
      if (values.isErr()) {
        return values;
      }
      if (values.value.length === 0) {
        continue;
      }
      for (const value of values.value) {
        if (typeof value !== "string") {
          return inputFailure(
            "malformed",
            "Captured JSON text field is not a string",
          );
        }
        if (value.trim() !== "") {
          nonempty = true;
        }
      }
      fields.push({ path, format: recipe.textFormat });
    }
    if (!nonempty) {
      continue;
    }
    return await readTextBaseline({
      format: TEXT_FORMAT.JSON,
      raw: new TextEncoder().encode(part),
      fields,
    });
  }
  return Result.ok(null);
};

type ReadJsonKeyedFieldOptions = {
  recipe: Extract<SourceBranch["recipe"], { type: "json-keyed-text" }>;
  part: string | undefined;
  budget: SourceBudget;
};
const readJsonKeyedField = async ({
  recipe,
  part,
  budget,
}: ReadJsonKeyedFieldOptions): Promise<BranchResult> => {
  if (part === undefined) {
    return Result.ok(null);
  }
  const parsed = parseJson(part);
  if (parsed.isErr()) {
    return parsed;
  }
  const collections = jsonPath({
    value: parsed.value,
    path: recipe.fieldsPath,
    budget,
  });
  if (collections.isErr()) {
    return collections;
  }
  if (collections.value.length === 0) {
    return Result.ok(null);
  }
  const collection = collections.value.at(0);
  if (collections.value.length !== 1 || !Array.isArray(collection)) {
    return inputFailure(
      "malformed",
      "Captured keyed text fields are not one array",
    );
  }
  let selected: string | null = null;
  let matched = false;
  for (const field of collection) {
    budget.nodes += 1;
    if (budget.nodes > TEXT_ORACLE_LIMITS.nodes) {
      return inputFailure(
        "resource_limit",
        "Keyed text fields exceed the node limit",
      );
    }
    if (!isRecord(field) || typeof field[recipe.keyProperty] !== "string") {
      return inputFailure("malformed", "Captured keyed field has no key");
    }
    if (field[recipe.keyProperty] !== recipe.key) {
      continue;
    }
    if (matched) {
      return inputFailure(
        "malformed",
        "Captured JSON contains duplicate decision text fields",
      );
    }
    matched = true;
    const value = field[recipe.valueProperty];
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      return inputFailure("malformed", "Captured keyed text is not a string");
    }
    selected = value;
  }
  return selected === null || selected.trim() === ""
    ? Result.ok(null)
    : await readTextBaseline({
        format: recipe.textFormat,
        raw: new TextEncoder().encode(selected),
      });
};

type ObjectRecipe = Extract<SourceBranch["recipe"], { type: "object" }>;
type ObjectNamesOptions = { recipe: ObjectRecipe; source: DecodedSource };
const objectNames = ({
  recipe,
  source,
}: ObjectNamesOptions): Result<
  { name: string; ordinal: number }[],
  SourceInputError
> => {
  const names: { name: string; ordinal: number }[] = [];
  const available = new Set([
    ...Object.keys(source.objects),
    ...source.directObjects.keys(),
  ]);
  if (available.has(recipe.part)) {
    names.push({ name: recipe.part, ordinal: 1 });
  }
  if (recipe.multiplicity === "numbered-family") {
    for (const name of available) {
      if (!name.startsWith(`${recipe.part}-`)) {
        continue;
      }
      const suffix = name.slice(recipe.part.length + 1);
      const ordinal = Number(suffix);
      if (
        !/^[1-9]\d*$/u.test(suffix) ||
        !Number.isSafeInteger(ordinal) ||
        ordinal < 2
      ) {
        return inputFailure(
          "malformed",
          "Captured binary family has an invalid part number",
        );
      }
      names.push({ name, ordinal });
    }
  }

  names.sort((left, right) => left.ordinal - right.ordinal);
  return Result.ok(names);
};

type ReadObjectBytesOptions = Pick<
  ReadBranchOptions,
  "branch" | "source" | "budget" | "cache" | "readBinary"
> & { name: string };
const readObjectBytes = async ({
  branch,
  source,
  budget,
  cache,
  readBinary,
  name,
}: ReadObjectBytesOptions): Promise<Result<Uint8Array, SourceFailure>> => {
  let raw = source.directObjects.get(name);
  if (raw === undefined) {
    const ref =
      source.objects[name] ?? panic("Selected source object reference exists");
    if (ref.byteLength + budget.bytes > TEXT_ORACLE_LIMITS.rawBytes) {
      return inputFailure(
        "resource_limit",
        "Captured binary family exceeds the byte limit",
      );
    }
    if (
      branch.format === TEXT_FORMAT.PDF &&
      !/^application\/pdf(?:;|$)/iu.test(ref.contentType)
    ) {
      return /^image\//iu.test(ref.contentType)
        ? Result.err(
            new TextOracleError({
              reason: "no_text_layer",
              message: "Captured image has no readable text layer",
            }),
          )
        : inputFailure(
            "unsupported",
            "Captured binary has an unsupported content type",
          );
    }
    const read = await readCapturedBinary({
      ref,
      readBinary: async (location) => {
        const cached = cache.get(location);
        if (cached !== undefined) {
          return cached;
        }
        return readBinary === undefined ? null : await readBinary(location);
      },
    });
    if (read.isErr()) {
      return read;
    }
    raw = read.value;
    if (!cache.has(ref.location)) {
      budget.cacheBytes += raw.byteLength;
      if (budget.cacheBytes > TEXT_ORACLE_LIMITS.rawBytes) {
        return inputFailure(
          "resource_limit",
          "Captured binary cache exceeds the byte limit",
        );
      }
      cache.set(ref.location, raw);
    }
  }
  return Result.ok(raw);
};

type ReadObjectFamilyOptions = Pick<
  ReadBranchOptions,
  "branch" | "source" | "budget" | "cache" | "readBinary"
> & { recipe: ObjectRecipe };
const readObjectFamily = async ({
  branch,
  recipe,
  source,
  budget,
  cache,
  readBinary,
}: ReadObjectFamilyOptions): Promise<BranchResult> => {
  const names = objectNames({ recipe, source });
  if (names.isErr()) {
    return names;
  }
  if (names.value.length === 0) {
    return Result.ok(null);
  }
  const texts: string[] = [];
  let characters = 0;
  for (const [index, { name, ordinal }] of names.value.entries()) {
    if (ordinal !== index + 1) {
      return inputFailure(
        "unavailable",
        "Captured binary family is missing a part",
      );
    }
    const read = await readObjectBytes({
      branch,
      source,
      budget,
      cache,
      readBinary,
      name,
    });
    if (read.isErr()) {
      return read;
    }
    const raw = read.value;
    budget.bytes += raw.byteLength;
    if (budget.bytes > TEXT_ORACLE_LIMITS.rawBytes) {
      return inputFailure(
        "resource_limit",
        "Captured binary family exceeds the byte limit",
      );
    }
    const baseline = await readResolvedBytes({ branch, raw });
    if (baseline.isErr()) {
      return baseline;
    }
    characters += baseline.value.text.length + 1;
    if (characters > TEXT_ORACLE_LIMITS.textCharacters) {
      return inputFailure(
        "resource_limit",
        "Captured binary text exceeds the character limit",
      );
    }
    texts.push(baseline.value.text);
  }
  return Result.ok({ text: texts.join("\n") });
};
const readBranch = async ({
  branch,
  source,
  format,
  budget,
  cache,
  readBinary,
}: ReadBranchOptions): Promise<BranchResult> => {
  const { recipe } = branch;
  const part = source.parts[recipe.part];
  switch (recipe.type) {
    case "envelope-text":
      return part === undefined
        ? Result.ok(null)
        : await readResolvedBytes({
            branch,
            raw: new TextEncoder().encode(part),
          });
    case "html-input":
      return await readHtmlInput({ branch, recipe, part, budget });
    case "envelope-base64":
      return await readEnvelopeBase64({ branch, recipe, part, source });
    case "json-base64":
      return await readJsonBase64({ branch, recipe, part, budget });
    case "json-text":
      return await readJsonFields({ recipe, part, budget });
    case "json-keyed-text":
      return await readJsonKeyedField({ recipe, part, budget });
    case "opinion-candidates":
      return part === undefined
        ? Result.ok(null)
        : await readOpinions({ text: part, format, budget });
    case "object":
      return await readObjectFamily({
        branch,
        recipe,
        source,
        budget,
        cache,
        readBinary,
      });
    default:
      recipe satisfies never;
      return panic("Unhandled source transport recipe");
  }
};

export type ReadSourceTextBaselineOptions = {
  raw: Uint8Array;
  contentType: string | null;
  sourceKey: SourceKey;
  /** Bound storage I/O at the caller; the resolver never fetches the raw payload again. */
  readBinary?: StoredRawReader;
  /** Per-attempt cache shared with parser replay; every hit is still fingerprint-checked. */
  binaryCache?: Map<string, Uint8Array>;
};

/** Declared precedence selects one representation; failures never fall through to a weaker one. */
export const readSourceTextBaseline = async ({
  raw,
  contentType,
  sourceKey,
  readBinary,
  binaryCache,
}: ReadSourceTextBaselineOptions): Promise<BaselineResult> => {
  const format = SOURCE_FORMATS[sourceKey];
  const decoded = decodeSource({ raw, contentType, sourceKey, format });
  if (decoded.isErr()) {
    return decoded;
  }
  const cache = binaryCache ?? new Map<string, Uint8Array>();
  let cacheBytes = 0;
  for (const bytes of cache.values()) {
    cacheBytes += bytes.byteLength;
    if (cacheBytes > TEXT_ORACLE_LIMITS.rawBytes) {
      return inputFailure(
        "resource_limit",
        "Captured binary cache exceeds the byte limit",
      );
    }
  }
  const budget: SourceBudget = { nodes: 0, bytes: 0, cacheBytes };
  for (const branch of format.branches) {
    const result = await readBranch({
      branch,
      format,
      source: decoded.value,
      budget,
      cache,
      readBinary,
    });
    if (result.isErr()) {
      return result;
    }
    if (result.value === null) {
      continue;
    }
    if (result.value.text.trim() === "") {
      return inputFailure(
        "unavailable",
        "Captured decision source has no visible text",
      );
    }
    return Result.ok(result.value);
  }
  if (
    format.branches.some(
      ({ recipe }) =>
        recipe.type === "envelope-base64" &&
        decoded.value.parts[recipe.part] !== undefined,
    )
  ) {
    return inputFailure(
      "unsupported",
      "Captured base64 has an unsupported content type",
    );
  }
  return inputFailure(
    "unavailable",
    "Captured source lacks a declared decision-text part",
  );
};
