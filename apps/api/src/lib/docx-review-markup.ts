const DOCX_REVIEW_INSERT_TAG = "review-insert";
const DOCX_REVIEW_DELETE_TAG = "review-delete";
const DOCX_REVIEW_COMMENT_TAG = "review-comment";
const DOCX_REVIEW_INSERT_CLOSE = `</${DOCX_REVIEW_INSERT_TAG}>`;
const DOCX_REVIEW_DELETE_CLOSE = `</${DOCX_REVIEW_DELETE_TAG}>`;
const DOCX_REVIEW_COMMENT_CLOSE = `</${DOCX_REVIEW_COMMENT_TAG}>`;

type DocxReviewMetadata = {
  author?: string;
  initials?: string;
  date?: string;
  status?: "open" | "resolved";
  thread?: "root" | "reply";
};

type RenderDocxReviewMarkupOptions = {
  contentKind?: "markup" | "text";
  metadata?: DocxReviewMetadata;
  text: string;
};

export const DOCX_REVIEW_MARKUP_EXAMPLES = {
  insertion: `<${DOCX_REVIEW_INSERT_TAG} author="AUTHOR" initials="AU" date="2026-05-07">inserted text${DOCX_REVIEW_INSERT_CLOSE}`,
  deletion: `<${DOCX_REVIEW_DELETE_TAG} author="AUTHOR" initials="AU" date="2026-05-07">deleted text${DOCX_REVIEW_DELETE_CLOSE}`,
  comment: `<${DOCX_REVIEW_COMMENT_TAG} author="AUTHOR" initials="AU" date="2026-05-07" status="open">comment text${DOCX_REVIEW_COMMENT_CLOSE}`,
} as const;

const escapeReviewAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const DOCX_REVIEW_TAG_TEXT_PATTERN =
  /<\/?(?:review-insert|review-delete|review-comment)(?:\s[^<>]*)?>/g;

export const escapeDocxReviewText = (value: string): string =>
  value.replaceAll(DOCX_REVIEW_TAG_TEXT_PATTERN, (tag) =>
    tag.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  );

const unescapeDocxReviewText = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");

const normalizeReviewDate = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, 10) : trimmed;
};

const renderMetadataAttributes = (metadata: DocxReviewMetadata): string => {
  const attributes: string[] = [];
  const date = normalizeReviewDate(metadata.date);
  const entries: [string, string | undefined][] = [
    ["author", metadata.author],
    ["initials", metadata.initials],
    ["date", date],
    ["status", metadata.status],
    ["thread", metadata.thread],
  ];

  for (const [name, value] of entries) {
    if (!value) {
      continue;
    }
    attributes.push(`${name}="${escapeReviewAttribute(value)}"`);
  }

  return attributes.length === 0 ? "" : ` ${attributes.join(" ")}`;
};

export const renderDocxInsertionMarkup = ({
  contentKind = "text",
  text,
  metadata = {},
}: RenderDocxReviewMarkupOptions): string =>
  `<${DOCX_REVIEW_INSERT_TAG}${renderMetadataAttributes(metadata)}>${contentKind === "markup" ? text : escapeDocxReviewText(text)}${DOCX_REVIEW_INSERT_CLOSE}`;

export const renderDocxDeletionMarkup = ({
  contentKind = "text",
  text,
  metadata = {},
}: RenderDocxReviewMarkupOptions): string =>
  `<${DOCX_REVIEW_DELETE_TAG}${renderMetadataAttributes(metadata)}>${contentKind === "markup" ? text : escapeDocxReviewText(text)}${DOCX_REVIEW_DELETE_CLOSE}`;

export const renderDocxCommentMarkup = ({
  contentKind = "text",
  text,
  metadata = {},
}: RenderDocxReviewMarkupOptions): string =>
  `<${DOCX_REVIEW_COMMENT_TAG}${renderMetadataAttributes(metadata)}>${contentKind === "markup" ? text : escapeDocxReviewText(text)}${DOCX_REVIEW_COMMENT_CLOSE}`;

const normalizeSearchWhitespace = (text: string): string => {
  let out = "";
  let pendingSpace = false;

  for (const char of text) {
    if (char.trim().length === 0) {
      pendingSpace = out.length > 0;
      continue;
    }

    if (",.;:!?".includes(char)) {
      if (out.endsWith(" ")) {
        out = out.slice(0, -1);
      }
      out += char;
      continue;
    }

    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += char;
  }

  return out.trim();
};

type MarkerBounds = {
  openPrefix: string;
  close: string;
};

const DOCX_REVIEW_MARKER_BOUNDS: MarkerBounds[] = [
  {
    openPrefix: `<${DOCX_REVIEW_INSERT_TAG}`,
    close: DOCX_REVIEW_INSERT_CLOSE,
  },
  {
    openPrefix: `<${DOCX_REVIEW_DELETE_TAG}`,
    close: DOCX_REVIEW_DELETE_CLOSE,
  },
  {
    openPrefix: `<${DOCX_REVIEW_COMMENT_TAG}`,
    close: DOCX_REVIEW_COMMENT_CLOSE,
  },
];

const readMarkedContent = (
  text: string,
  index: number,
  bounds: MarkerBounds,
): { content: string; nextIndex: number } | null => {
  if (!text.startsWith(bounds.openPrefix, index)) {
    return null;
  }

  const openEnd = text.indexOf(">", index + bounds.openPrefix.length);
  if (openEnd === -1) {
    return null;
  }

  const contentStart = openEnd + 1;
  let depth = 1;
  let cursor = contentStart;

  while (cursor < text.length) {
    const nextOpen = text.indexOf(bounds.openPrefix, cursor);
    const nextClose = text.indexOf(bounds.close, cursor);

    if (nextClose === -1) {
      return null;
    }

    if (nextOpen !== -1 && nextOpen < nextClose) {
      const nestedOpenEnd = text.indexOf(
        ">",
        nextOpen + bounds.openPrefix.length,
      );
      if (nestedOpenEnd === -1) {
        return null;
      }

      depth++;
      cursor = nestedOpenEnd + 1;
      continue;
    }

    depth--;
    if (depth === 0) {
      return {
        content: text.slice(contentStart, nextClose),
        nextIndex: nextClose + bounds.close.length,
      };
    }

    cursor = nextClose + bounds.close.length;
  }

  return null;
};

const stripDocxReviewMarkup = (text: string): string => {
  let out = "";
  let index = 0;

  while (index < text.length) {
    let matched = false;
    for (const marker of DOCX_REVIEW_MARKER_BOUNDS) {
      const result = readMarkedContent(text, index, marker);
      if (!result) {
        continue;
      }

      out += ` ${stripDocxReviewMarkup(result.content)} `;
      index = result.nextIndex;
      matched = true;
      break;
    }

    if (matched) {
      continue;
    }

    out += text[index];
    index++;
  }

  return out;
};

export const docxReviewMarkupToSearchText = (text: string): string =>
  normalizeSearchWhitespace(
    unescapeDocxReviewText(stripDocxReviewMarkup(text)),
  );
