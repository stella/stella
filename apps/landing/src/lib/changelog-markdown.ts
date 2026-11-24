type ChangelogMarkdownBlock =
  | { level: 1 | 2 | 3; text: string; type: "heading" }
  | { alt: string; src: string; type: "image" }
  | { items: string[]; type: "list" }
  | { text: string; type: "paragraph" }
  | { src: string; type: "video" };

type ChangelogInlineSegment =
  | { text: string; type: "bold" }
  | { text: string; type: "code" }
  | { href: string; text: string; type: "link" }
  | { text: string; type: "text" };

const HTML_VIDEO_PATTERN =
  /^<video\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/video>$/iu;
const MARKDOWN_IMAGE_PATTERN = /^!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)$/u;

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

const pushText = (segments: ChangelogInlineSegment[], text: string) => {
  if (!text) {
    return;
  }
  const previous = segments.at(-1);
  if (previous?.type === "text") {
    previous.text += text;
    return;
  }
  segments.push({ text, type: "text" });
};

export const parseChangelogInline = (
  text: string,
): ChangelogInlineSegment[] => {
  const segments: ChangelogInlineSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    if (text.startsWith("**", cursor)) {
      const close = text.indexOf("**", cursor + 2);
      if (close > cursor + 2) {
        segments.push({ text: text.slice(cursor + 2, close), type: "bold" });
        cursor = close + 2;
        continue;
      }
    }

    if (text[cursor] === "`") {
      const close = text.indexOf("`", cursor + 1);
      if (close > cursor + 1) {
        segments.push({ text: text.slice(cursor + 1, close), type: "code" });
        cursor = close + 1;
        continue;
      }
    }

    if (text[cursor] === "[") {
      const closeLabel = text.indexOf("](", cursor + 1);
      if (closeLabel > cursor + 1) {
        const closeUrl = text.indexOf(")", closeLabel + 2);
        const urlStart = closeLabel + 2;
        const rawUrl =
          closeUrl > urlStart ? text.slice(urlStart, closeUrl) : "";
        if (
          rawUrl &&
          (rawUrl.startsWith("https://") || rawUrl.startsWith("http://")) &&
          !/\s/u.test(rawUrl)
        ) {
          const label = text.slice(cursor + 1, closeLabel);
          const safeHref = safeHttpsUrl(rawUrl);
          if (safeHref) {
            segments.push({ href: safeHref, text: label, type: "link" });
          } else {
            pushText(segments, label);
          }
          cursor = closeUrl + 1;
          continue;
        }
      }
    }

    let next = text.length;
    for (const marker of ["**", "`", "["]) {
      const pos = text.indexOf(marker, cursor + 1);
      if (pos !== -1 && pos < next) {
        next = pos;
      }
    }
    pushText(segments, text.slice(cursor, next));
    cursor = next;
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
