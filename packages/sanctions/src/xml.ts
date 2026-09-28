import { Result } from "better-result";
import { SaxesParser } from "saxes";

import { SanctionsListParseError } from "./entry";
import type {
  ListVersion,
  ParsedList,
  SanctionsEntry,
  SanctionsSource,
} from "./entry";

/** One list record materialised as a small tree; the document never is. */
export type XmlNode = {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
};

type RootAttributes = Record<string, string>;

type ReadState = {
  failure: SanctionsListParseError | null;
  rootAttributes: RootAttributes | null;
};

/**
 * The elements allowed as children of the root and of each list container.
 * Anything else outside a record fails the read, so a renamed or new record
 * element can never be skipped silently.
 */
type XmlLayout = Readonly<Record<string, ReadonlySet<string>>>;

type ReadXmlOptions = {
  input: AsyncIterable<Uint8Array>;
  source: SanctionsSource;
  rootName: string;
  /** "root" stops reading once the root element's attributes are known. */
  extent: "root" | "document";
  layout: XmlLayout;
  recordNames: ReadonlySet<string>;
  onRecord: (record: XmlNode) => Result<void, SanctionsListParseError>;
};

const readXml = async ({
  input,
  source,
  rootName,
  extent,
  layout,
  recordNames,
  onRecord,
}: ReadXmlOptions): Promise<
  Result<RootAttributes, SanctionsListParseError>
> => {
  const parser = new SaxesParser();
  const state: ReadState = { failure: null, rootAttributes: null };
  const stack: XmlNode[] = [];
  // Open elements above the current record: the root and list containers.
  const containers: string[] = [];

  const fail = (code: SanctionsListParseError["code"], message: string) => {
    state.failure ??= new SanctionsListParseError({ code, message, source });
  };

  parser.on("error", (error) => fail("malformed-input", error.message));
  parser.on("opentag", (tag) => {
    if (state.failure !== null) {
      return;
    }
    if (state.rootAttributes === null) {
      if (tag.name !== rootName) {
        fail(
          "unexpected-structure",
          `expected <${rootName}>, found <${tag.name}>`,
        );
        return;
      }
      state.rootAttributes = tag.attributes;
      containers.push(tag.name);
      return;
    }
    if (stack.length === 0) {
      const parent = containers.at(-1) ?? rootName;
      if (layout[parent]?.has(tag.name) !== true) {
        fail(
          "unexpected-structure",
          `unexpected <${tag.name}> inside <${parent}>`,
        );
        return;
      }
      if (!recordNames.has(tag.name)) {
        containers.push(tag.name);
        return;
      }
    }
    const node: XmlNode = {
      name: tag.name,
      attributes: tag.attributes,
      children: [],
      text: "",
    };
    stack.at(-1)?.children.push(node);
    stack.push(node);
  });
  parser.on("text", (text) => {
    const node = stack.at(-1);
    if (node !== undefined) {
      node.text += text;
    }
  });
  parser.on("closetag", () => {
    if (state.failure !== null) {
      return;
    }
    const node = stack.pop();
    if (node === undefined) {
      containers.pop();
      return;
    }
    if (stack.length > 0) {
      return;
    }
    const handled = onRecord(node);
    if (handled.isErr()) {
      state.failure ??= handled.error;
    }
  });

  const done = () =>
    state.failure !== null ||
    (extent === "root" && state.rootAttributes !== null);

  const fed = await Result.tryPromise({
    try: async () => {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for await (const chunk of input) {
        parser.write(decoder.decode(chunk, { stream: true }));
        if (done()) {
          return;
        }
      }
      parser.write(decoder.decode());
      parser.close();
    },
    catch: (cause) =>
      new SanctionsListParseError({
        code: "malformed-input",
        message: `could not read the ${source} list: ${String(cause)}`,
        source,
      }),
  });
  if (fed.isErr()) {
    return Result.err(fed.error);
  }
  if (state.failure !== null) {
    return Result.err(state.failure);
  }
  if (state.rootAttributes === null) {
    return Result.err(
      new SanctionsListParseError({
        code: "malformed-input",
        message: "the document has no root element",
        source,
      }),
    );
  }
  return Result.ok(state.rootAttributes);
};

/** How one XML list maps onto entries and an edition stamp. */
export type XmlListFormat = {
  source: SanctionsSource;
  rootName: string;
  layout: XmlLayout;
  recordNames: ReadonlySet<string>;
  toEntry: (record: XmlNode) => Result<SanctionsEntry, SanctionsListParseError>;
  toVersion: (
    root: RootAttributes,
  ) => Result<ListVersion, SanctionsListParseError>;
};

/**
 * Streams an XML list and converts each record as soon as it closes, so memory
 * stays bounded by one record plus the entries rather than the file. Any
 * well-formedness error, a wrong root, a failed record, or an empty list fails
 * the whole parse: a list is either complete or an error, never a prefix.
 */
export const parseXmlList = async (
  format: XmlListFormat,
  input: AsyncIterable<Uint8Array>,
): Promise<Result<ParsedList, SanctionsListParseError>> => {
  const entries: SanctionsEntry[] = [];
  const read = await readXml({
    input,
    source: format.source,
    rootName: format.rootName,
    extent: "document",
    layout: format.layout,
    recordNames: format.recordNames,
    onRecord: (record) => {
      const entry = format.toEntry(record);
      if (entry.isErr()) {
        return Result.err(entry.error);
      }
      entries.push(entry.value);
      return Result.ok();
    },
  });
  if (read.isErr()) {
    return Result.err(read.error);
  }
  if (entries.length === 0) {
    return Result.err(
      new SanctionsListParseError({
        code: "empty-list",
        message: `the ${format.source} list has no entries`,
        source: format.source,
      }),
    );
  }
  return format.toVersion(read.value).map((version) => ({ version, entries }));
};

/** Reads only the edition stamp at the start of a list and stops there. */
export const readXmlListVersion = async (
  format: XmlListFormat,
  input: AsyncIterable<Uint8Array>,
): Promise<Result<ListVersion, SanctionsListParseError>> => {
  const read = await readXml({
    input,
    source: format.source,
    rootName: format.rootName,
    extent: "root",
    layout: format.layout,
    recordNames: format.recordNames,
    onRecord: () => Result.ok(),
  });
  return read.andThen(format.toVersion);
};

export const childrenNamed = (node: XmlNode, name: string): XmlNode[] =>
  node.children.filter((child) => child.name === name);

/** Trimmed text of the first child with this name; empty text reads as null. */
export const childText = (node: XmlNode, name: string): string | null => {
  const text = node.children.find((child) => child.name === name)?.text.trim();
  return text === undefined || text === "" ? null : text;
};

/** Trimmed attribute value; absent or empty reads as null. */
export const attribute = (node: XmlNode, name: string): string | null => {
  const value = node.attributes[name]?.trim();
  return value === undefined || value === "" ? null : value;
};
