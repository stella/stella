import { Result } from "better-result";

import {
  createDocumentText,
  documentPackageError,
  type DocumentXmlNode,
  type DocumentXmlReader,
} from "@/api/lib/files/xml-document-package";

const UYAP_CONTENT_PATH = "content.xml";
const UYAP_FORMAT_VERSIONS = new Set(["1.7", "1.8"]);

// The UYAP Editor uses Java UTF-16 offsets. A run must not split a character.
const isCharacterBoundary = (text: string, offset: number): boolean => {
  const code = text.codePointAt(offset);
  return code === undefined || code < 0xdc_00 || code > 0xdf_ff;
};

const unsignedInteger = (value: string | undefined): number => {
  if (value === undefined || !/^\d+$/u.test(value)) {
    return Number.NaN;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : Number.NaN;
};

const blockChildren = new Set(["paragraph", "table", "page-break"]);
const layoutChildren = {
  elements: new Set([...blockChildren, "header", "footer"]),
  header: blockChildren,
  footer: blockChildren,
  "page-break": blockChildren,
  table: new Set(["row"]),
  row: new Set(["cell"]),
  cell: blockChildren,
};
const textRuns = new Set(["content", "field", "space", "tab"]);
const isLayoutContainer = (name: string): name is keyof typeof layoutChildren =>
  Object.hasOwn(layoutChildren, name);

export const readUyapDocument = (
  readXml: DocumentXmlReader,
  maxChars: number,
) => {
  const parsed = readXml(UYAP_CONTENT_PATH);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }

  const root = parsed.value;
  const pools = root.children.filter(
    (node) => node.localName === "content" && node.namespaceURI === "",
  );
  const layouts = root.children.filter(
    (node) => node.localName === "elements" && node.namespaceURI === "",
  );
  const pool = pools.at(0);
  const layout = layouts.at(0);
  if (
    root.localName !== "template" ||
    root.namespaceURI !== "" ||
    !UYAP_FORMAT_VERSIONS.has(root.attributes.get("format_id") ?? "") ||
    root.text.trim() !== "" ||
    pools.length !== 1 ||
    !pool ||
    pool.children.length !== 0 ||
    layouts.length !== 1 ||
    !layout
  ) {
    return Result.err(documentPackageError("Unsupported UYAP document layout"));
  }

  const source = pool.text;
  const output = createDocumentText(maxChars);
  let remaining = maxChars + 2;
  let leadingWhitespaceBudget = source.length;
  let started = false;

  const append = (value: string) => {
    output.append(value);
    remaining -= value.length;
  };

  const appendRange = (rangeStart: number, end: number): boolean => {
    let start = rangeStart;
    if (remaining <= 0 || start === end) {
      return true;
    }
    if (!started) {
      // Repeated references cannot force us to scan more than one pool of padding.
      const scanEnd = Math.min(end, start + leadingWhitespaceBudget + 1);
      const prefix = source.slice(start, scanEnd);
      const text = prefix.trimStart();
      const skipped = prefix.length - text.length;
      leadingWhitespaceBudget -= skipped;
      if (leadingWhitespaceBudget < 0) {
        return false;
      }
      if (!text) {
        return true;
      }
      start += skipped;
      started = true;
    }
    const limit = Math.min(end, start + remaining);
    // Give the output limiter a complete surrogate pair at the cut.
    const afterPair = !isCharacterBoundary(source, limit);
    append(source.slice(start, afterPair ? limit + 1 : limit));
    return true;
  };

  const renderParagraph = (node: DocumentXmlNode): boolean => {
    let pending: { start: number; end: number } | undefined;
    let firstRun = true;
    for (const run of node.children) {
      if (
        run.namespaceURI !== "" ||
        run.children.length !== 0 ||
        run.text.trim()
      ) {
        return false;
      }
      if (run.localName === "image") {
        continue;
      }
      if (!textRuns.has(run.localName)) {
        return false;
      }
      const start = unsignedInteger(run.attributes.get("startOffset"));
      const length = unsignedInteger(run.attributes.get("length"));
      const end = start + length;
      if (
        !Number.isFinite(end) ||
        (length === 0 && run.localName === "field") ||
        end > source.length ||
        !isCharacterBoundary(source, start) ||
        !isCharacterBoundary(source, end)
      ) {
        return false;
      }
      if (length === 0) {
        continue;
      }

      if (pending) {
        if (!appendRange(pending.start, pending.end)) {
          return false;
        }
        firstRun = false;
      }
      pending = { start, end };
    }
    if (pending) {
      // A paragraph's stored terminator and the layout separator represent one break.
      const end =
        source.charAt(pending.end - 1) === "\n" ? pending.end - 1 : pending.end;
      const emptyPlaceholder =
        firstRun &&
        end - pending.start === 1 &&
        source.charAt(pending.start) === "\u200b";
      return emptyPlaceholder || appendRange(pending.start, end);
    }
    return true;
  };

  const renderLayout = (node: DocumentXmlNode): boolean => {
    if (node.namespaceURI !== "" || node.text.trim() !== "") {
      return false;
    }
    if (node.localName === "paragraph") {
      return renderParagraph(node);
    }
    if (!isLayoutContainer(node.localName)) {
      return false;
    }

    const children = layoutChildren[node.localName];
    const separator = node.localName === "row" ? "\t" : "\n";
    let first = true;
    for (const child of node.children) {
      if (!children.has(child.localName)) {
        return false;
      }
      if (!first && started && remaining > 0) {
        append(separator);
      }
      if (!renderLayout(child)) {
        return false;
      }
      first = false;
    }
    return true;
  };

  if (!renderLayout(layout)) {
    return Result.err(
      documentPackageError("Invalid UYAP text references or layout"),
    );
  }
  return output.finish();
};
