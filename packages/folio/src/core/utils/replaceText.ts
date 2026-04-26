/**
 * Lightweight text replacement on the document model.
 * Used by find & replace. Operates immutably.
 */

import type {
  Document,
  DocumentBody,
  Paragraph,
  Run,
  TextContent,
  ParagraphContent,
  TextFormatting,
} from "../types/document";

type ReplaceRange = {
  start: { paragraphIndex: number; offset: number };
  end: { paragraphIndex: number; offset: number };
};

/** Replace text within a range in the document. Returns a new document. */
export function replaceTextInDocument(
  doc: Document,
  range: ReplaceRange,
  text: string,
  formatting?: TextFormatting,
): Document {
  const newDoc = structuredClone(doc);
  const body = newDoc.package.document;
  const { start, end } = range;

  if (start.paragraphIndex === end.paragraphIndex) {
    const blockIndex = getBlockIndexForParagraph(body, start.paragraphIndex);
    if (blockIndex === -1) {return newDoc;}

    const paragraph = body.content[blockIndex] as Paragraph;
    paragraph.content = deleteTextInParagraph(
      paragraph,
      start.offset,
      end.offset,
    );
    paragraph.content = insertTextAtOffset(
      paragraph,
      start.offset,
      text,
      formatting,
    );
  } else {
    const startBlockIndex = getBlockIndexForParagraph(
      body,
      start.paragraphIndex,
    );
    const startParagraph = body.content[startBlockIndex] as Paragraph;
    const startText = getParagraphText(startParagraph);

    startParagraph.content = deleteTextInParagraph(
      startParagraph,
      start.offset,
      startText.length,
    );
    startParagraph.content = insertTextAtOffset(
      startParagraph,
      start.offset,
      text,
      formatting,
    );

    const paragraphsToRemove: number[] = [];
    for (let i = start.paragraphIndex + 1; i <= end.paragraphIndex; i++) {
      paragraphsToRemove.push(getBlockIndexForParagraph(body, i));
    }
    for (let i = paragraphsToRemove.length - 1; i >= 0; i--) {
      // SAFETY: i >= 0 and i < paragraphsToRemove.length in for loop
      const idx = paragraphsToRemove[i]!;
      if (idx !== -1) {
        body.content.splice(idx, 1);
      }
    }
  }

  return newDoc;
}

// ---------------------------------------------------------------------------
// Helpers (extracted from the former agent/executor)
// ---------------------------------------------------------------------------

function getBlockIndexForParagraph(
  body: DocumentBody,
  paragraphIndex: number,
): number {
  let pIdx = 0;
  for (let i = 0; i < body.content.length; i++) {
    // SAFETY: i < body.content.length in for loop
    if (body.content[i]!.type === "paragraph") {
      if (pIdx === paragraphIndex) {return i;}
      pIdx++;
    }
  }
  return -1;
}

function getParagraphText(paragraph: Paragraph): string {
  let text = "";
  for (const item of paragraph.content) {
    if (item.type === "run") {
      for (const c of item.content) {
        if (c.type === "text") {text += c.text;}
      }
    } else if (item.type === "hyperlink") {
      for (const child of item.children) {
        if (child.type !== "run") {continue;}
        for (const c of child.content) {
          if (c.type === "text") {text += c.text;}
        }
      }
    }
  }
  return text;
}

function deleteTextInParagraph(
  paragraph: Paragraph,
  startOffset: number,
  endOffset: number,
): ParagraphContent[] {
  const result: ParagraphContent[] = [];
  let currentOffset = 0;

  for (const item of paragraph.content) {
    if (item.type === "run") {
      const newContent: Run["content"] = [];
      for (const content of item.content) {
        if (content.type === "text") {
          const textStart = currentOffset;
          const textEnd = currentOffset + content.text.length;

          if (textEnd <= startOffset || textStart >= endOffset) {
            newContent.push(content);
          } else {
            let newText = "";
            if (textStart < startOffset) {
              newText += content.text.slice(0, startOffset - textStart);
            }
            if (textEnd > endOffset) {
              newText += content.text.slice(endOffset - textStart);
            }
            if (newText) {
              newContent.push({ ...content, text: newText });
            }
          }
          currentOffset = textEnd;
        } else {
          newContent.push(content);
        }
      }
      if (newContent.length > 0) {
        result.push({ ...item, content: newContent });
      }
    } else {
      result.push(item);
    }
  }

  return result;
}

function insertTextAtOffset(
  paragraph: Paragraph,
  offset: number,
  text: string,
  formatting?: TextFormatting,
): ParagraphContent[] {
  if (!text) {return paragraph.content;}

  let currentOffset = 0;

  for (const item of paragraph.content) {
    if (item.type === "run") {
      for (let ci = 0; ci < item.content.length; ci++) {
        // SAFETY: ci < item.content.length in for loop
        const content = item.content[ci]!;
        if (content.type === "text") {
          const textStart = currentOffset;
          const textEnd = currentOffset + content.text.length;

          if (offset >= textStart && offset <= textEnd) {
            const relOffset = offset - textStart;
            if (formatting) {
              const before = content.text.slice(0, relOffset);
              const after = content.text.slice(relOffset);
              const newContent: Run["content"] = [];
              if (before) {newContent.push({ type: "text", text: before });}
              const newRun: TextContent = { type: "text", text };
              item.content.splice(ci, 1, ...newContent);
              const insertRun: Run = {
                type: "run",
                content: [newRun],
                formatting,
              };
              const afterItems: Run["content"] = [];
              if (after)
                {afterItems.push({ type: "text" as const, text: after });}
              const remaining = item.content.splice(ci + newContent.length);
              const afterRun: Run = {
                type: "run",
                content: [...remaining, ...afterItems],
                ...(item.formatting !== undefined ? { formatting: item.formatting } : {}),
              };
              const idx = paragraph.content.indexOf(item);
              paragraph.content.splice(idx + 1, 0, insertRun);
              if (afterItems.length > 0 || remaining.length > 0) {
                paragraph.content.splice(idx + 2, 0, afterRun);
              }
              return paragraph.content;
            }
            content.text =
              content.text.slice(0, relOffset) +
              text +
              content.text.slice(relOffset);
            return paragraph.content;
          }
          currentOffset = textEnd;
        }
      }
    }
  }

  // If we get here, insert at the end
  const lastRun = paragraph.content.findLast(
    (item): item is Run => item.type === "run",
  );
  if (lastRun) {
    lastRun.content.push({ type: "text", text });
  } else {
    paragraph.content.push({
      type: "run",
      content: [{ type: "text", text }],
      formatting: formatting ?? {},
    });
  }

  return paragraph.content;
}
