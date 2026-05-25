import type {
  BlockContent,
  DocumentBody,
  HeaderFooter,
  Paragraph,
  SectionProperties,
  Table,
} from "../types/document";

type NormalizeHeaderFooterReferencesInput = {
  documentBody: DocumentBody;
  headers?: Map<string, HeaderFooter>;
  footers?: Map<string, HeaderFooter>;
};

type NormalizeHeaderFooterReferencesResult = {
  removedDanglingHeaderReferences: number;
  removedDanglingFooterReferences: number;
};

export const normalizeHeaderFooterReferences = ({
  documentBody,
  headers,
  footers,
}: NormalizeHeaderFooterReferencesInput): NormalizeHeaderFooterReferencesResult => {
  const seenSectionProperties = new Set<SectionProperties>();
  let removedDanglingHeaderReferences = 0;
  let removedDanglingFooterReferences = 0;

  const normalizeSectionProperties = (
    sectionProperties: SectionProperties | undefined,
  ): void => {
    if (!sectionProperties || seenSectionProperties.has(sectionProperties)) {
      return;
    }
    seenSectionProperties.add(sectionProperties);

    const headerResult = removeDanglingReferences(
      sectionProperties.headerReferences,
      headers,
    );
    if (headerResult.changed) {
      removedDanglingHeaderReferences += headerResult.removed;
      if (headerResult.references.length > 0) {
        sectionProperties.headerReferences = headerResult.references;
      } else {
        delete sectionProperties.headerReferences;
      }
    }

    const footerResult = removeDanglingReferences(
      sectionProperties.footerReferences,
      footers,
    );
    if (footerResult.changed) {
      removedDanglingFooterReferences += footerResult.removed;
      if (footerResult.references.length > 0) {
        sectionProperties.footerReferences = footerResult.references;
      } else {
        delete sectionProperties.footerReferences;
      }
    }
  };

  const normalizeParagraph = (paragraph: Paragraph): void => {
    normalizeSectionProperties(paragraph.sectionProperties);
  };

  const normalizeTable = (table: Table): void => {
    for (const row of table.rows) {
      for (const cell of row.cells) {
        normalizeParagraphTableBlocks(cell.content);
      }
    }
  };

  const normalizeBlock = (block: BlockContent): void => {
    if (block.type === "paragraph") {
      normalizeParagraph(block);
      return;
    }
    if (block.type === "table") {
      normalizeTable(block);
      return;
    }
    normalizeParagraphTableBlocks(block.content);
  };

  const normalizeBlocks = (blocks: BlockContent[]): void => {
    for (const block of blocks) {
      normalizeBlock(block);
    }
  };

  const normalizeParagraphTableBlocks = (
    blocks: (Paragraph | Table)[],
  ): void => {
    for (const block of blocks) {
      if (block.type === "paragraph") {
        normalizeParagraph(block);
        continue;
      }
      normalizeTable(block);
    }
  };

  normalizeBlocks(documentBody.content);
  normalizeSectionProperties(documentBody.finalSectionProperties);
  for (const section of documentBody.sections ?? []) {
    normalizeSectionProperties(section.properties);
  }

  return {
    removedDanglingHeaderReferences,
    removedDanglingFooterReferences,
  };
};

type HeaderFooterReference = {
  rId: string;
};

type RemoveDanglingReferencesResult<T extends HeaderFooterReference> = {
  changed: boolean;
  references: T[];
  removed: number;
};

const removeDanglingReferences = <T extends HeaderFooterReference>(
  references: T[] | undefined,
  validParts: Map<string, HeaderFooter> | undefined,
): RemoveDanglingReferencesResult<T> => {
  if (!references || !validParts) {
    return { changed: false, references: references ?? [], removed: 0 };
  }

  const kept = references.filter((reference) => validParts.has(reference.rId));
  return {
    changed: kept.length !== references.length,
    references: kept,
    removed: references.length - kept.length,
  };
};
