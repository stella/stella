import type {
  BlockContent,
  Comment,
  DocumentBody,
  Endnote,
  Footnote,
  HeaderFooter,
  Paragraph,
  ParagraphContent,
  Table,
} from "../types/document";

type NormalizeCommentReferencesInput = {
  documentBody: DocumentBody;
  comments: readonly Comment[];
  headers?: Map<string, HeaderFooter>;
  footers?: Map<string, HeaderFooter>;
  footnotes?: readonly Footnote[];
  endnotes?: readonly Endnote[];
};

type NormalizeCommentReferencesResult = {
  removedDanglingReferences: number;
  reanchoredUnbalancedRanges: number;
};

type CommentRangeMarkerRef = {
  content: ParagraphContent[];
  index: number;
  id: number;
  type: "commentRangeStart" | "commentRangeEnd";
};

export const normalizeCommentReferences = ({
  documentBody,
  comments,
  headers,
  footers,
  footnotes,
  endnotes,
}: NormalizeCommentReferencesInput): NormalizeCommentReferencesResult => {
  const validCommentIds = new Set(comments.map((comment) => comment.id));
  const rangeMarkers: CommentRangeMarkerRef[] = [];
  let removedDanglingReferences = 0;

  const normalizeParagraph = (paragraph: Paragraph): void => {
    const nextContent: ParagraphContent[] = [];
    for (const content of paragraph.content) {
      if (isCommentMarker(content) && !validCommentIds.has(content.id)) {
        removedDanglingReferences += 1;
        continue;
      }
      nextContent.push(content);
      if (isCommentRangeMarker(content)) {
        rangeMarkers.push({
          content: nextContent,
          index: nextContent.length - 1,
          id: content.id,
          type: content.type,
        });
      }
    }
    paragraph.content = nextContent;
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
  for (const header of headers?.values() ?? []) {
    normalizeParagraphTableBlocks(header.content);
  }
  for (const footer of footers?.values() ?? []) {
    normalizeParagraphTableBlocks(footer.content);
  }
  for (const footnote of footnotes ?? []) {
    normalizeParagraphTableBlocks(footnote.content);
  }
  for (const endnote of endnotes ?? []) {
    normalizeParagraphTableBlocks(endnote.content);
  }
  for (const comment of comments) {
    for (const paragraph of comment.content) {
      normalizeParagraph(paragraph);
    }
  }

  return {
    removedDanglingReferences,
    reanchoredUnbalancedRanges: reanchorUnbalancedCommentRanges(rangeMarkers),
  };
};

const reanchorUnbalancedCommentRanges = (
  rangeMarkers: readonly CommentRangeMarkerRef[],
): number => {
  const byId = new Map<number, CommentRangeMarkerRef[]>();
  for (const marker of rangeMarkers) {
    const markers = byId.get(marker.id);
    if (markers) {
      markers.push(marker);
      continue;
    }
    byId.set(marker.id, [marker]);
  }

  let reanchoredCount = 0;
  for (const markers of byId.values()) {
    const starts = markers.filter(
      (marker) => marker.type === "commentRangeStart",
    );
    const ends = markers.filter((marker) => marker.type === "commentRangeEnd");
    const unbalanced =
      starts.length > ends.length
        ? starts.slice(ends.length)
        : ends.slice(starts.length);
    for (const marker of unbalanced) {
      marker.content[marker.index] = {
        type: "commentReference",
        id: marker.id,
      };
      reanchoredCount += 1;
    }
  }
  return reanchoredCount;
};

const isCommentMarker = (
  content: ParagraphContent,
): content is Extract<
  ParagraphContent,
  | { type: "commentRangeStart" }
  | { type: "commentRangeEnd" }
  | { type: "commentReference" }
> =>
  content.type === "commentRangeStart" ||
  content.type === "commentRangeEnd" ||
  content.type === "commentReference";

const isCommentRangeMarker = (
  content: ParagraphContent,
): content is Extract<
  ParagraphContent,
  { type: "commentRangeStart" } | { type: "commentRangeEnd" }
> => content.type === "commentRangeStart" || content.type === "commentRangeEnd";
