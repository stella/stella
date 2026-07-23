export type ChangelogMarkdownBlock =
  | { level: 1 | 2 | 3; text: string; type: "heading" }
  | { items: string[]; type: "list" }
  | { text: string; type: "paragraph" }
  | { src: string; type: "video" };

const HTML_VIDEO_PATTERN =
  /^<video\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/video>$/iu;
const MARKDOWN_VIDEO_PATTERN = /^!\[[^\]]*\]\((https:\/\/[^)\s]+)\)$/u;

const parseHeading = (line: string) => {
  if (line.startsWith("### ")) {
    return { level: 3 as const, text: line.slice(4) };
  }
  if (line.startsWith("## ")) {
    return { level: 2 as const, text: line.slice(3) };
  }
  if (line.startsWith("# ")) {
    return { level: 1 as const, text: line.slice(2) };
  }
  return null;
};

export const parseChangelogMarkdown = (body: string) => {
  const blocks: ChangelogMarkdownBlock[] = [];
  let paragraphLines: string[] = [];
  let listItems: string[] = [];

  const closeParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    blocks.push({ text: paragraphLines.join(" "), type: "paragraph" });
    paragraphLines = [];
  };

  const closeList = () => {
    if (listItems.length === 0) {
      return;
    }

    blocks.push({ items: listItems, type: "list" });
    listItems = [];
  };

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      closeParagraph();
      closeList();
      continue;
    }

    const htmlVideoSrc = HTML_VIDEO_PATTERN.exec(line)?.[1];
    const markdownVideoSrc = MARKDOWN_VIDEO_PATTERN.exec(line)?.[1];
    const videoSrc = htmlVideoSrc ?? markdownVideoSrc;
    if (videoSrc) {
      closeParagraph();
      closeList();
      blocks.push({ src: videoSrc, type: "video" });
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      closeParagraph();
      closeList();
      blocks.push({
        level: heading.level,
        text: heading.text,
        type: "heading",
      });
      continue;
    }

    if (line.startsWith("- ")) {
      closeParagraph();
      listItems.push(line.slice(2));
      continue;
    }

    closeList();
    paragraphLines.push(line);
  }

  closeParagraph();
  closeList();
  return blocks;
};
