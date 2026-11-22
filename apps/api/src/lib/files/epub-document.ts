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

type Manifest = ReadonlyMap<string, { href: string; type: string }>;

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

/** The chapters in reading order, as package paths. */
const spineChapters = (opf: DocumentXmlNode, opfPath: string): string[] => {
  const manifest: Manifest = new Map(
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
                href: path,
                type: (item.attributes.get("media-type") ?? "").toLowerCase(),
              },
            ] as const,
          ];
    }),
  );
  return [...descendants(opf, OPF_NS, "itemref")]
    .filter((itemref) => itemref.attributes.get("linear") !== "no")
    .flatMap((itemref) => {
      const item = manifest.get(itemref.attributes.get("idref") ?? "");
      return item !== undefined && CHAPTER_TYPES.has(item.type)
        ? [item.href]
        : [];
    })
    .slice(0, MAX_CHAPTERS);
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
  const readBytes = (path: string): Uint8Array | null => {
    const entry = entries.get(path);
    if (entry === undefined) {
      return null;
    }
    const read = readArchiveEntry(entry);
    return Result.isOk(read) ? read.value : null;
  };
  const readXml = (path: string): DocumentXmlNode | null => {
    const part = readBytes(path);
    if (part === null) {
      return null;
    }
    const parsed = parseStandaloneXml(part, MAX_PACKAGE_XML_BYTES);
    return Result.isOk(parsed) ? parsed.value : null;
  };

  const container = readXml(CONTAINER_PATH);
  const opfPath = container === null ? null : packageDocumentPath(container);
  const opf = opfPath === null ? null : readXml(opfPath);
  if (opfPath === null || opf === null) {
    return Result.err(ebookError("The e-book has no readable package"));
  }
  const chapters = spineChapters(opf, opfPath);
  if (chapters.length === 0) {
    return Result.err(ebookError("The e-book lists no chapters"));
  }

  const embed = createImageEmbedder();
  const bodies: string[] = [];
  let length = 0;
  for (const chapter of chapters) {
    const source = readBytes(chapter);
    if (source === null) {
      continue;
    }
    const $ = load(new TextDecoder().decode(source));
    // An image drawn through SVG (a cover, a full-page plate) becomes a
    // plain image, since the sanitizer keeps no SVG.
    $("svg image").each((_, element) => {
      const image = $(element);
      const href = image.attr("xlink:href") ?? image.attr("href") ?? "";
      image.closest("svg").replaceWith($("<img>").attr("src", href));
    });
    embedImages($, (reference) => {
      const path = packagePath(chapter, reference);
      const image = path === null ? null : readBytes(path);
      const type = path === null ? null : embeddableImageType(null, path);
      return image === null || type === null ? null : embed(type, image);
    });
    const body = $("body").html() ?? "";
    length += body.length;
    if (length > RENDERED_HTML_MAX_CHARS) {
      break;
    }
    bodies.push(`<div>${body}</div>`);
  }
  if (bodies.length === 0) {
    return Result.err(ebookError("The e-book's chapters could not be read"));
  }
  const book = load("");
  book("body").html(bodies.join("<hr>"));
  return Result.ok(finishRenderedHtml(book.html()));
};
