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
  const declared =
    /^<\?xml\s+[^?]*?\bencoding\s*=\s*["'](gb18030|windows-1254)["']/iu
      .exec(prefix)?.[1]
      ?.toLowerCase();
  return declared ?? "utf-8";
};

const parseXmlPart = (bytes: Uint8Array, consumeNode: () => void) =>
  Result.try({
    try: () => {
      const encoding = xmlEncoding(bytes);
      const xml = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      const parser = new SaxesParser({ xmlns: true });
      const stack: DocumentXmlNode[] = [];
      let root: DocumentXmlNode | undefined;
      parser.on("doctype", () => {
        throw documentPackageError(
          "Document type declarations are unsupported",
        );
      });
      parser.on("xmldecl", ({ encoding: declared }) => {
        if (
          declared &&
          declared.toLowerCase() !== encoding &&
          !(
            encoding.startsWith("utf-16") && declared.toLowerCase() === "utf-16"
          )
        ) {
          throw documentPackageError("Unsupported document encoding");
        }
      });
      parser.on("attribute", consumeNode);
      parser.on("opentag", (tag) => {
        consumeNode();
        if (stack.length >= MAX_XML_DEPTH) {
          throw limitError();
        }
        const node: DocumentXmlNode = {
          localName: tag.local,
          namespaceURI: tag.uri,
          attributes: new Map(
            Object.values(tag.attributes).map(({ name, value }) => [
              name,
              value,
            ]),
          ),
          children: [],
          text: "",
        };
        const parent = stack.at(-1);
        if (parent) {
          parent.children.push(node);
        } else {
          root = node;
        }
        stack.push(node);
      });
      const append = (value: string) => {
        const node = stack.at(-1);
        if (node) {
          node.text += value;
        }
      };
      parser.on("text", append);
      parser.on("cdata", append);
      parser.on("closetag", () => {
        stack.pop();
      });
      parser.write(xml).close();
      if (!root) {
        throw documentPackageError("Missing document root");
      }
      return root;
    },
    catch: (error) =>
      error instanceof DocumentPackageError
        ? error
        : documentPackageError("The document contains unreadable XML"),
  });

export const openXmlDocumentPackage = async (
  bytes: Uint8Array,
): Promise<Result<DocumentXmlReader, DocumentPackageError>> => {
  const archive = await openDocumentArchive(bytes);
  if (archive.isErr()) {
    return Result.err(archive.error);
  }
  let remainingBytes = MAX_XML_TOTAL_BYTES;
  let remainingParts = MAX_XML_PARTS;
  let remainingNodes = MAX_XML_NODES;
  const consumeNode = () => {
    if (--remainingNodes < 0) {
      throw limitError();
    }
  };
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
      : parseXmlPart(data.value, consumeNode);
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
