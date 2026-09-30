import { encodePaginationCursor } from "@/api/lib/pagination";

const OUTLINE_LIMIT = 100;
const TITLE_LIMIT = 200;
const NUMBERED_SECTION = /^(?:[IVXLCDM]+[.)]|\d+[.)]|\[\d+\])(?:\s|$)/u;

type DecisionOutlineOptions = {
  blocks: readonly { type: string; plainText: string }[] | null;
  text: string;
};

export const decisionOutline = ({ blocks, text }: DecisionOutlineOptions) => {
  const entries = new Map<number, string>();
  let offset = 0;
  for (const block of blocks ?? []) {
    if (entries.size >= OUTLINE_LIMIT) {
      break;
    }
    const found = text.indexOf(block.plainText, offset);
    if (block.plainText.length === 0 || found === -1) {
      continue;
    }
    offset = found + block.plainText.length;
    if (block.type === "heading") {
      entries.set(found, block.plainText);
    }
  }
  // Plain-text decisions also carry numbered sections and reasoning paragraphs.
  for (const line of text.matchAll(/[^\r\n]+/gu)) {
    if (entries.size >= OUTLINE_LIMIT) {
      break;
    }
    const title = line[0].trim();
    if (NUMBERED_SECTION.test(title)) {
      entries.set(line.index + line[0].indexOf(title), title);
    }
  }
  return [...entries]
    .toSorted(([left], [right]) => left - right)
    .slice(0, OUTLINE_LIMIT)
    .map(([start, title]) => ({
      title: title.slice(0, TITLE_LIMIT),
      // Navigation skips citation lists; the initial read already supplies them.
      cursor: encodePaginationCursor([start, null]),
    }));
};
