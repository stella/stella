import { Result } from "better-result";
import { SaxesParser } from "saxes";

import {
  DocumentPackageError,
  openDocumentArchive,
  readArchiveEntry,
} from "@/api/lib/files/document-archive";

export type DocumentXmlNode = {
  localName: string;
  namespaceURI: string;
  attributes: ReadonlyMap<string, string>;
  children: DocumentXmlNode[];
  text: string;
};

export type DocumentXmlReader = (
  path: string,
) => Result<DocumentXmlNode, DocumentPackageError>;

export const documentPackageError = (message: string) =>
  new DocumentPackageError({ message, reason: "invalid" });

const limitError = () =>
  new DocumentPackageError({
    message: "The document exceeds the XML reading limits",
    reason: "limit",
  });

const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_XML_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_XML_PARTS = 2048;
const MAX_XML_NODES = 150_000;
const MAX_XML_DEPTH = 96;

// Feed the parser in slices so a failure recorded by a callback stops the read
// within one slice instead of after the whole part.
const XML_WRITE_CHUNK_CHARS = 64 * 1024;
const LEGACY_XML_ENCODINGS = ["gb18030", "windows-1254"] as const;
const DECLARED_ENCODING = /\bencoding\s*=\s*["']([\w.:-]{1,40})["']/u;

const unreadableXml = () =>
  documentPackageError("The document contains unreadable XML");

// The declaration is ASCII-compatible for both legacy encodings. Honor only
// explicit declarations; malformed UTF-8 must never silently change alphabets.
const xmlEncoding = (bytes: Uint8Array) => {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf-16le";
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf-16be";
  }
  const prefix = Buffer.from(bytes.subarray(0, 512)).toString("latin1");
  if (!/^<\?xml\s/u.test(prefix)) {
    return "utf-8";
  }
  // The declaration ends at its first `?`, which only `?>` may contain.
  const declarationEnd = prefix.indexOf("?", 5);
  const declaration = prefix.slice(
    5,
    declarationEnd === -1 ? undefined : declarationEnd,
  );
  const declared = DECLARED_ENCODING.exec(declaration)?.[1]?.toLowerCase();
  return (
    LEGACY_XML_ENCODINGS.find((encoding) => encoding === declared) ?? "utf-8"
  );
};

type XmlNodeBudget = { remaining: number };

const parseXmlPart = (
  bytes: Uint8Array,
  budget: XmlNodeBudget,
): Result<DocumentXmlNode, DocumentPackageError> => {
  const encoding = xmlEncoding(bytes);
  const decoded = Result.try(() =>
    new TextDecoder(encoding, { fatal: true }).decode(bytes),
  );
  if (decoded.isErr()) {
    return Result.err(unreadableXml());
  }
  const xml = decoded.value;
  const parser = new SaxesParser({ xmlns: true });
  const stack: DocumentXmlNode[] = [];
  // Written by the parser's callbacks. The first failure ends the read.
  const read: {
    failure: DocumentPackageError | null;
    root: DocumentXmlNode | null;
  } = { failure: null, root: null };
  const fail = (failure: DocumentPackageError) => {
    read.failure ??= failure;
  };
  const consumeNode = () => {
    budget.remaining -= 1;
    if (budget.remaining < 0) {
      fail(limitError());
    }
  };
  parser.on("error", () => {
    fail(unreadableXml());
  });
  parser.on("doctype", () => {
    fail(documentPackageError("Document type declarations are unsupported"));
  });
  parser.on("xmldecl", ({ encoding: declared }) => {
    if (
      declared &&
      declared.toLowerCase() !== encoding &&
      !(encoding.startsWith("utf-16") && declared.toLowerCase() === "utf-16")
    ) {
      fail(documentPackageError("Unsupported document encoding"));
    }
  });
  parser.on("attribute", consumeNode);
  parser.on("opentag", (tag) => {
    consumeNode();
    if (stack.length >= MAX_XML_DEPTH) {
      fail(limitError());
    }
    if (read.failure) {
      return;
    }
    const node: DocumentXmlNode = {
      localName: tag.local,
      namespaceURI: tag.uri,
      attributes: new Map(
        Object.values(tag.attributes).map(({ name, value }) => [name, value]),
      ),
      children: [],
      text: "",
    };
    const parent = stack.at(-1);
    if (parent) {
      parent.children.push(node);
    } else {
      read.root = node;
    }
    stack.push(node);
  });
  const append = (value: string) => {
    const node = stack.at(-1);
    if (node && !read.failure) {
      node.text += value;
    }
  };
  parser.on("text", append);
  parser.on("cdata", append);
  parser.on("closetag", () => {
    stack.pop();
  });
  const written = Result.try(() => {
    for (
      let offset = 0;
      offset < xml.length && !read.failure;
      offset += XML_WRITE_CHUNK_CHARS
    ) {
      parser.write(xml.slice(offset, offset + XML_WRITE_CHUNK_CHARS));
    }
    if (!read.failure) {
      parser.close();
    }
  });
  if (written.isErr()) {
    return Result.err(unreadableXml());
  }
  if (read.failure) {
    return Result.err(read.failure);
  }
  if (!read.root) {
    return Result.err(documentPackageError("Missing document root"));
  }
  return Result.ok(read.root);
};

export const openXmlDocumentPackage = async (
  bytes: Uint8Array,
): Promise<Result<DocumentXmlReader, DocumentPackageError>> => {
  const archive = await openDocumentArchive(bytes);
  if (archive.isErr()) {
    return Result.err(archive.error);
  }
  let remainingBytes = MAX_XML_TOTAL_BYTES;
  let remainingParts = MAX_XML_PARTS;
  const nodes: XmlNodeBudget = { remaining: MAX_XML_NODES };
  const readXml: DocumentXmlReader = (path) => {
    const entry = archive.value.get(path);
    if (!entry || path.endsWith("/")) {
      return Result.err(
        documentPackageError("A required document part is missing"),
      );
    }
    remainingBytes -= entry.uncompressedSize;
    if (
      --remainingParts < 0 ||
      remainingBytes < 0 ||
      entry.uncompressedSize > MAX_XML_BYTES
    ) {
      return Result.err(limitError());
    }
    const data = readArchiveEntry(entry);
    return data.isErr()
      ? Result.err(data.error)
      : parseXmlPart(data.value, nodes);
  };
  return Result.ok(readXml);
};

export const createDocumentText = (maxChars: number) => {
  let text = "";
  let truncated = false;
  return {
    append: (part: string) => {
      if (!part || truncated) {
        return;
      }
      const value = text ? part : part.trimStart();
      const remaining = maxChars - text.length;
      if (value.length > remaining) {
        truncated = true;
        text += value.slice(0, remaining);
        if (/[\uD800-\uDBFF]$/u.test(text)) {
          text = text.slice(0, -1);
        }
      } else {
        text += value;
      }
    },
    finish: () =>
      text.trim()
        ? Result.ok({ text: text.trimEnd(), truncated })
        : Result.err(documentPackageError("The document has no readable text")),
  };
};
