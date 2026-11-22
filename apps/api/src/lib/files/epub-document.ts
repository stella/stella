/**
 * An e-book (.epub) as one HTML document: the chapters its package lists in
 * reading order (the spine), each chapter's body after the last, with the
 * images the book carries embedded. The package is read through the bounded
 * archive reader and its XML through the bounded XML reader; nothing is
 * fetched.
 */
import { Result, TaggedError } from "better-result";

import { load } from "@stll/html";

import {
  openDocumentArchive,
  readArchiveEntry,
} from "@/api/lib/files/document-archive";
import {
  createImageEmbedder,
  embeddableImageType,
  embedImages,
  finishRenderedHtml,
  RENDERED_HTML_MAX_CHARS,
} from "@/api/lib/files/rendered-html";
import {
  type DocumentXmlNode,
  parseStandaloneXml,
} from "@/api/lib/files/xml-document-package";

export class EbookError extends TaggedError("EbookError")<{
  message: string;
  cause?: unknown;
}> {}

const CONTAINER_PATH = "META-INF/container.xml";
const CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container";
const OPF_NS = "http://www.idpf.org/2007/opf";
/** Package documents are a few hundred kilobytes at most. */
const MAX_PACKAGE_XML_BYTES = 4 * 1024 * 1024;
/** Spine entries read; a longer book is previewed up to this chapter. */
const MAX_CHAPTERS = 1000;
/** Decompressed bytes all of a book's parts may take together. */
const MAX_READ_BYTES = 96 * 1024 * 1024;
const CHAPTER_TYPES: ReadonlySet<string> = new Set([
  "application/xhtml+xml",
  "text/html",
]);

const ebookError = (message: string, cause?: unknown) =>
  new EbookError({ message, cause });

const descendants = function* (
  node: DocumentXmlNode,
  namespace: string,
  localName: string,
): Generator<DocumentXmlNode> {
  for (const child of node.children) {
    if (child.namespaceURI === namespace && child.localName === localName) {
      yield child;
    }
    yield* descendants(child, namespace, localName);
  }
};

/**
 * A reference inside the package, resolved against the part that makes it.
 * References that leave the package (a scheme, `//`, or `..` above its root)
 * resolve to nothing.
 */
const packagePath = (owner: string, reference: string): string | null => {
  const [withoutFragment = ""] = reference.split("#", 1);
  const decoded = Result.try(() => decodeURIComponent(withoutFragment.trim()));
  if (
    Result.isError(decoded) ||
    decoded.value === "" ||
    decoded.value.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/iu.test(decoded.value)
  ) {
    return null;
  }
  const parts = decoded.value.startsWith("/")
    ? []
    : owner.split("/").slice(0, -1);
  for (const part of decoded.value.replace(/^\/+/u, "").split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.pop() === undefined) {
        return null;
      }
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? null : parts.join("/");
};

/** The package document's path, from the container's first root file. */
const packageDocumentPath = (container: DocumentXmlNode): string | null => {
  for (const rootFile of descendants(container, CONTAINER_NS, "rootfile")) {
    const path = rootFile.attributes.get("full-path");
    if (path !== undefined && path.trim() !== "") {
      return packagePath("", path);
    }
  }
  return null;
};

type PackageContents = {
  /** The chapters in reading order, as package paths. */
  readonly chapters: readonly string[];
  /** Each manifest item's declared media type, by package path. */
  readonly typeByPath: ReadonlyMap<string, string>;
};

/**
 * The package's manifest and reading order. A linear spine entry that names
 * no manifest item is a broken book, not a chapter to leave out.
 */
const packageContents = (
  opf: DocumentXmlNode,
  opfPath: string,
): Result<PackageContents, EbookError> => {
  const items = new Map(
    [...descendants(opf, OPF_NS, "item")].flatMap((item) => {
      const id = item.attributes.get("id");
      const href = item.attributes.get("href");
      const path = href === undefined ? null : packagePath(opfPath, href);
      return id === undefined || path === null
        ? []
        : [
            [
              id,
              {
                path,
                type: (item.attributes.get("media-type") ?? "").toLowerCase(),
              },
            ] as const,
          ];
    }),
  );
  const chapters: string[] = [];
  for (const itemref of descendants(opf, OPF_NS, "itemref")) {
    if (itemref.attributes.get("linear") === "no") {
      continue;
    }
    const item = items.get(itemref.attributes.get("idref") ?? "");
    if (item === undefined) {
      return Result.err(
        ebookError("The e-book's reading order names a missing chapter"),
      );
    }
    if (CHAPTER_TYPES.has(item.type) && chapters.length < MAX_CHAPTERS) {
      chapters.push(item.path);
    }
  }
  return Result.ok({
    chapters,
    typeByPath: new Map(
      [...items.values()].map(({ path, type }) => [path, type] as const),
    ),
  });
};

/**
 * A chapter's text: UTF-16 by its byte order mark, else UTF-8, which EPUB
 * requires of its content documents. A chapter declaring another encoding,
 * or whose bytes are not valid in its encoding, fails rather than being read
 * as corrupted text.
 */
const decodeChapter = (bytes: Uint8Array): Result<string, EbookError> => {
  const declared = /^<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]{1,40})["']/u
    .exec(Buffer.from(bytes.subarray(0, 512)).toString("latin1"))?.[1]
    ?.toLowerCase();
  let encoding: "utf-8" | "utf-16le" | "utf-16be" = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
  } else if (declared !== undefined && !/^utf-?8$/u.test(declared)) {
    return Result.err(
      ebookError("An e-book chapter uses an unsupported encoding"),
    );
  }
  const decoded = Result.try(() =>
    new TextDecoder(encoding, { fatal: true }).decode(bytes),
  );
  return Result.isOk(decoded)
    ? Result.ok(decoded.value)
    : Result.err(ebookError("An e-book chapter is not readable text"));
};

/** An e-book's chapters as one self-contained, sanitized HTML document. */
export const ebookToHtml = async (
  bytes: Uint8Array,
): Promise<Result<Uint8Array, EbookError>> => {
  const archive = await openDocumentArchive(bytes);
  if (Result.isError(archive)) {
    return Result.err(
      ebookError("The e-book could not be read", archive.error),
    );
  }
  const entries = archive.value;
  // Every part is decompressed at most once, and all reads together within
  // one budget, however often the package refers to a part.
  const reads = new Map<string, Result<Uint8Array | null, EbookError>>();
  let readBudget = MAX_READ_BYTES;
  const readBytes = (path: string): Result<Uint8Array | null, EbookError> => {
    const cached = reads.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const entry = entries.get(path);
    let read: Result<Uint8Array | null, EbookError>;
    if (entry === undefined) {
      read = Result.ok(null);
    } else if (entry.uncompressedSize > readBudget) {
      read = Result.err(ebookError("The e-book exceeds the reading limits"));
    } else {
      readBudget -= entry.uncompressedSize;
      const data = readArchiveEntry(entry);
      read = Result.isOk(data)
        ? Result.ok(data.value)
        : Result.err(
            ebookError("An e-book part could not be read", data.error),
          );
    }
    reads.set(path, read);
    return read;
  };
  const readXml = (path: string): DocumentXmlNode | null => {
    const part = readBytes(path);
    if (Result.isError(part) || part.value === null) {
      return null;
    }
    const parsed = parseStandaloneXml(part.value, MAX_PACKAGE_XML_BYTES);
    return Result.isOk(parsed) ? parsed.value : null;
  };

  const container = readXml(CONTAINER_PATH);
  const opfPath = container === null ? null : packageDocumentPath(container);
  const opf = opfPath === null ? null : readXml(opfPath);
  if (opfPath === null || opf === null) {
    return Result.err(ebookError("The e-book has no readable package"));
  }
  const contents = packageContents(opf, opfPath);
  if (Result.isError(contents)) {
    return contents;
  }
  // A chapter the spine lists twice renders once.
  const chapters = [...new Set(contents.value.chapters)];
  if (chapters.length === 0) {
    return Result.err(ebookError("The e-book lists no chapters"));
  }

  const embed = createImageEmbedder();
  const bodies: string[] = [];
  let length = 0;
  for (const chapter of chapters) {
    const source = readBytes(chapter);
    if (Result.isError(source)) {
      return source;
    }
    if (source.value === null) {
      return Result.err(ebookError("An e-book chapter is missing"));
    }
    // Charged before parsing, so the parse itself is within the budget.
    length += source.value.byteLength;
    if (length > RENDERED_HTML_MAX_CHARS) {
      return Result.err(ebookError("The e-book exceeds the reading limits"));
    }
    const text = decodeChapter(source.value);
    if (Result.isError(text)) {
      return text;
    }
    const $ = load(text.value);
    // An image drawn through SVG (a cover, a full-page plate) becomes a
    // plain image, since the sanitizer keeps no SVG.
    $("svg image").each((_, element) => {
      const image = $(element);
      const href = image.attr("xlink:href") ?? image.attr("href") ?? "";
      image.closest("svg").replaceWith($("<img>").attr("src", href));
    });
    // Written by the image callback; the first failed read ends the render.
    const imageRead: { failure: EbookError | null } = { failure: null };
    embedImages($, (reference) => {
      const path = packagePath(chapter, reference);
      const type =
        path === null
          ? null
          : embeddableImageType(contents.value.typeByPath.get(path), path);
      if (path === null || type === null) {
        return null;
      }
      const image = readBytes(path);
      if (Result.isError(image)) {
        imageRead.failure ??= image.error;
        return null;
      }
      return image.value === null ? null : embed(type, image.value);
    });
    if (imageRead.failure !== null) {
      return Result.err(imageRead.failure);
    }
    bodies.push(`<div>${$("body").html() ?? ""}</div>`);
  }
  const book = load("");
  book("body").html(bodies.join("<hr>"));
  return Result.ok(finishRenderedHtml(book.html()));
};
