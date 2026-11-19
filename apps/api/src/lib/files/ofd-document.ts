import { Result } from "better-result";

import type { DocumentPackageError } from "@/api/lib/files/document-archive";
import {
  createDocumentText,
  documentPackageError,
  type DocumentXmlNode,
  type DocumentXmlReader,
} from "@/api/lib/files/xml-document-package";

const OFD_ENTRY = "OFD.xml";
const OFD_NS = "http://www.ofdspec.org/2016";

const ofdChildren = (node: DocumentXmlNode, name: string) =>
  node.children.filter(
    (child) => child.namespaceURI === OFD_NS && child.localName === name,
  );

function resolveLocation(
  owner: string,
  location: string | undefined,
): Result<string, DocumentPackageError> {
  const reference = location?.trim() ?? "";
  if (
    !reference ||
    reference.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:|[\\\p{Cc}]/iu.test(reference)
  ) {
    return Result.err(documentPackageError("Invalid OFD package reference."));
  }

  const parts = reference.startsWith("/") ? [] : owner.split("/").slice(0, -1);
  for (const part of reference.replace(/^\//u, "").split("/")) {
    if (part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.pop() === undefined) {
        return Result.err(
          documentPackageError("Invalid OFD package reference."),
        );
      }
      continue;
    }
    if (!part) {
      return Result.err(documentPackageError("Invalid OFD package reference."));
    }
    parts.push(part);
  }

  return parts.length > 0
    ? Result.ok(parts.join("/"))
    : Result.err(documentPackageError("Invalid OFD package reference."));
}

function readOfdXml(
  readXml: DocumentXmlReader,
  path: string,
  name: string,
): Result<DocumentXmlNode, DocumentPackageError> {
  const root = readXml(path);
  if (root.isErr()) {
    return root;
  }
  if (root.value.localName !== name || root.value.namespaceURI !== OFD_NS) {
    return Result.err(
      documentPackageError("Invalid OFD XML document structure."),
    );
  }
  return root;
}

function collectTextRuns(container: DocumentXmlNode, runs: string[]): void {
  for (const block of container.children) {
    if (block.namespaceURI !== OFD_NS) {
      continue;
    }
    if (block.localName === "PageBlock") {
      collectTextRuns(block, runs);
    } else if (block.localName === "TextObject") {
      for (const code of ofdChildren(block, "TextCode")) {
        // GB/T 33190-2016 §11.2 defines backslash escapes for character codes.
        const value = code.text
          .replace(/\\([\da-f]{4})/giu, (_, hex: string) =>
            String.fromCodePoint(Number.parseInt(hex, 16)),
          )
          .toWellFormed();
        if (value.trim()) {
          runs.push(value);
        }
      }
    }
  }
}

export function readOfdDocument(
  readXml: DocumentXmlReader,
  maxChars: number,
): Result<{ text: string; truncated: boolean }, DocumentPackageError> {
  const entry = readOfdXml(readXml, OFD_ENTRY, "OFD");
  if (entry.isErr()) {
    return Result.err(entry.error);
  }
  const bodies = ofdChildren(entry.value, "DocBody");
  if (bodies.length === 0) {
    return Result.err(
      documentPackageError("OFD has no declared document bodies."),
    );
  }

  const output = createDocumentText(maxChars);
  let hasPageText = false;
  for (const body of bodies) {
    const roots = ofdChildren(body, "DocRoot");
    const root = roots.at(0);
    if (!root || roots.length !== 1 || root.children.length > 0) {
      return Result.err(
        documentPackageError("OFD requires one document root per body."),
      );
    }
    const documentPath = resolveLocation(OFD_ENTRY, root.text);
    if (documentPath.isErr()) {
      return Result.err(documentPath.error);
    }
    const document = readOfdXml(readXml, documentPath.value, "Document");
    if (document.isErr()) {
      return Result.err(document.error);
    }

    const pageLists = ofdChildren(document.value, "Pages");
    const pageList = pageLists.at(0);
    if (!pageList || pageLists.length !== 1) {
      return Result.err(
        documentPackageError("OFD requires one page list per document."),
      );
    }
    const pages = ofdChildren(pageList, "Page");
    if (pages.length === 0) {
      return Result.err(documentPackageError("OFD has no declared pages."));
    }

    for (const pageReference of pages) {
      const pagePath = resolveLocation(
        documentPath.value,
        pageReference.attributes.get("BaseLoc"),
      );
      if (pagePath.isErr()) {
        return Result.err(pagePath.error);
      }
      const page = readOfdXml(readXml, pagePath.value, "Page");
      if (page.isErr()) {
        return Result.err(page.error);
      }
      const runs: string[] = [];
      for (const content of ofdChildren(page.value, "Content")) {
        for (const layer of ofdChildren(content, "Layer")) {
          collectTextRuns(layer, runs);
        }
      }
      if (runs.length > 0) {
        if (hasPageText) {
          output.append("\n\n");
        }
        output.append(runs.join("\n"));
        hasPageText = true;
      }
    }
  }

  if (!hasPageText) {
    return Result.err(
      documentPackageError(
        "OFD has no extractable page text. Image-only pages require OCR. Text in templates and other resources is unsupported.",
      ),
    );
  }
  return output.finish();
}
