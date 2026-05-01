import type {
  BlockContent,
  Document,
  Hyperlink,
  HeaderFooter,
  ParagraphContent,
  Run,
} from "../types/document";

export type DocxCompatibilityReason = "opaqueDrawing";

export type DocxCompatibility = {
  canSafelyEdit: boolean;
  reasons: DocxCompatibilityReason[];
  unsupportedContentCount: number;
};

const COMPATIBLE_DOCX: DocxCompatibility = {
  canSafelyEdit: true,
  reasons: [],
  unsupportedContentCount: 0,
};

export function inspectDocxCompatibility(doc: Document): DocxCompatibility {
  const reasons = new Set<DocxCompatibilityReason>();
  let unsupportedContentCount = 0;

  const record = (reason: DocxCompatibilityReason) => {
    reasons.add(reason);
    unsupportedContentCount += 1;
  };

  inspectBlocks(doc.package.document.content, record);
  for (const header of doc.package.headers?.values() ?? []) {
    inspectHeaderFooter(header, record);
  }
  for (const footer of doc.package.footers?.values() ?? []) {
    inspectHeaderFooter(footer, record);
  }
  for (const footnote of doc.package.footnotes ?? []) {
    inspectBlocks(footnote.content, record);
  }
  for (const endnote of doc.package.endnotes ?? []) {
    inspectBlocks(endnote.content, record);
  }

  if (unsupportedContentCount === 0) {
    return COMPATIBLE_DOCX;
  }

  return {
    canSafelyEdit: false,
    reasons: Array.from(reasons),
    unsupportedContentCount,
  };
}

function inspectBlocks(
  blocks: BlockContent[],
  record: (reason: DocxCompatibilityReason) => void,
): void {
  for (const block of blocks) {
    if (block.type === "paragraph") {
      inspectParagraphContent(block.content, record);
      continue;
    }

    if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          inspectBlocks(cell.content, record);
        }
      }
      continue;
    }

    if (block.type === "blockSdt") {
      inspectBlocks(block.content, record);
    }
  }
}

function inspectHeaderFooter(
  headerFooter: HeaderFooter,
  record: (reason: DocxCompatibilityReason) => void,
): void {
  inspectBlocks(headerFooter.content, record);
}

function inspectParagraphContent(
  content: ParagraphContent[],
  record: (reason: DocxCompatibilityReason) => void,
): void {
  for (const item of content) {
    if (item.type === "run") {
      inspectRun(item, record);
      continue;
    }

    if (item.type === "hyperlink") {
      inspectHyperlink(item, record);
      continue;
    }

    if (item.type === "inlineSdt") {
      inspectParagraphContent(item.content, record);
      continue;
    }

    if (
      item.type === "insertion" ||
      item.type === "deletion" ||
      item.type === "moveFrom" ||
      item.type === "moveTo"
    ) {
      inspectParagraphContent(item.content, record);
      continue;
    }

    if (item.type === "simpleField") {
      inspectParagraphContent(item.content, record);
      continue;
    }

    if (item.type === "complexField") {
      for (const run of item.fieldCode) {
        inspectRun(run, record);
      }
      for (const run of item.fieldResult) {
        inspectRun(run, record);
      }
    }
  }
}

function inspectHyperlink(
  hyperlink: Hyperlink,
  record: (reason: DocxCompatibilityReason) => void,
): void {
  for (const child of hyperlink.children) {
    if (child.type === "run") {
      inspectRun(child, record);
    }
  }
}

function inspectRun(
  run: Run,
  record: (reason: DocxCompatibilityReason) => void,
): void {
  for (const content of run.content) {
    if (content.type === "drawing" && content.rawXml) {
      record("opaqueDrawing");
    }
  }
}
