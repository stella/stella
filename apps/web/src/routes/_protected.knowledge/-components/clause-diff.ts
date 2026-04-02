import { diffArrays } from "diff";

type ClauseParagraph = {
  text: string;
  style?: string;
};

type DiffSegment = {
  text: string;
  type: "equal" | "added" | "removed";
};

type ParagraphDiff = {
  status: "equal" | "modified" | "added" | "removed";
  segments: DiffSegment[];
};

const WORD_TOKEN_RE = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_]+/gu;

const tokenize = (text: string): string[] => text.match(WORD_TOKEN_RE) ?? [];

/**
 * Diff two clause bodies paragraph-by-paragraph.
 * Aligns paragraphs by index; for matching indices
 * runs word-level diff. Paragraphs only in old are
 * "removed", only in new are "added".
 */
export const diffClauseBodies = (
  oldBody: ClauseParagraph[],
  newBody: ClauseParagraph[],
): ParagraphDiff[] => {
  const maxLen = Math.max(oldBody.length, newBody.length);
  const result: ParagraphDiff[] = [];

  for (let i = 0; i < maxLen; i++) {
    const oldP = oldBody[i];
    const newP = newBody[i];

    if (oldP === undefined) {
      if (newP !== undefined) {
        result.push({
          status: "added",
          segments: [{ text: newP.text, type: "added" }],
        });
      }
      continue;
    }

    if (newP === undefined) {
      result.push({
        status: "removed",
        segments: [{ text: oldP.text, type: "removed" }],
      });
      continue;
    }

    if (oldP.text === newP.text) {
      result.push({
        status: "equal",
        segments: [{ text: newP.text, type: "equal" }],
      });
      continue;
    }

    const segments: DiffSegment[] = diffArrays(
      tokenize(oldP.text),
      tokenize(newP.text),
    ).map((change) => ({
      text: change.value.join(""),
      type: change.added ? "added" : change.removed ? "removed" : "equal",
    }));

    result.push({ status: "modified", segments });
  }

  return result;
};

export type { ParagraphDiff };
