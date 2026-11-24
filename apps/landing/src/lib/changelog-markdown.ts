export type ChangelogMarkdownBlock =
  | { level: 1 | 2 | 3; text: string; type: "heading" }
  | { alt: string; src: string; type: "image" }
  | { items: string[]; type: "list" }
  | { text: string; type: "paragraph" }
  | { src: string; type: "video" };

export type ChangelogInlineSegment =
  | { text: string; type: "bold" }
  | { text: string; type: "code" }
  | { href: string; text: string; type: "link" }
  | { text: string; type: "text" };

const HTML_VIDEO_PATTERN =
  /^<video\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/video>$/iu;
const MARKDOWN_IMAGE_PATTERN = /^!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)$/u;
const INLINE_MARKDOWN_PATTERN =
  /(\*\*([^*]+)\*\*)|(`([^`]+)`)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu;

export const safeHttpsUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
};

export const removeFirstMarkdownHeading = (body: string): string => {
  const lines = body.split("\n");
  const titleIndex = lines.findIndex((line) => line.trim().startsWith("# "));
  if (titleIndex === -1) {
    return body.trim();
  }

  return [...lines.slice(0, titleIndex), ...lines.slice(titleIndex + 1)]
    .join("\n")
    .trim();
};

export const parseChangelogInline = (
  text: string,
): ChangelogInlineSegment[] => {
  const segments: ChangelogInlineSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE_MARKDOWN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ text: text.slice(cursor, index), type: "text" });
    }

    const boldText = match[2];
    const codeText = match[4];
    const linkText = match[5];
    const linkUrl = match[6];

    if (boldText) {
      segments.push({ text: boldText, type: "bold" });
    } else if (codeText) {
      segments.push({ text: codeText, type: "code" });
    } else if (linkText && linkUrl) {
      const safeHref = safeHttpsUrl(linkUrl);
      if (safeHref) {
        segments.push({ href: safeHref, text: linkText, type: "link" });
      } else {
        segments.push({ text: linkText, type: "text" });
      }
    }

    cursor = index + match[0].length;
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), type: "text" });
  }

  return segments;
};

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

    const videoSrc = HTML_VIDEO_PATTERN.exec(line)?.[1];
    if (videoSrc) {
      closeParagraph();
      closeList();
      blocks.push({ src: videoSrc, type: "video" });
      continue;
    }

    const imageMatch = MARKDOWN_IMAGE_PATTERN.exec(line);
    const imageSrc = imageMatch?.[2];
    if (imageMatch && imageSrc) {
      closeParagraph();
      closeList();
      blocks.push({
        alt: imageMatch.at(1) ?? "",
        src: imageSrc,
        type: "image",
      });
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
