import type {
  Autofix,
  LegalDraft,
  LegalDraftBlock,
  LegalDraftDiagnostic,
  LegalDocumentKind,
  LegalNumberingProfile,
  LegalPageOrientation,
  LegalPageSize,
  LegalSignatureParty,
  LegalSourceParseResult,
} from "./types";

const DEFAULT_KIND = "agreement" satisfies LegalDocumentKind;
const DEFAULT_LOCALE = "en-GB";
const DEFAULT_NUMBERING = "legal" satisfies LegalNumberingProfile;
const DEFAULT_PAGE_SIZE = "A4" satisfies LegalPageSize;
const DEFAULT_ORIENTATION = "portrait" satisfies LegalPageOrientation;

const DIRECTIVE_ALIASES: Record<string, string> = {
  "@annex": "@schedule",
  "@appendix": "@schedule",
  "@body": "@paragraph",
  "@para": "@paragraph",
  // @preamble was a thin styling variant of @paragraph; alias so any
  // legacy source still parses.
  "@preamble": "@paragraph",
  "@section": "@clause",
  "@signature": "@signatures",
  "@subsection": "@subclause",
};

const DIRECTIVES = new Set([
  "@doc",
  "@title",
  "@recital",
  "@clause",
  "@subclause",
  "@paragraph",
  "@list",
  "@table",
  "@schedule",
  "@signatures",
  "@pagebreak",
]);

type PendingBlock =
  | { type: "title"; line: number; heading: string; lines: string[] }
  | { type: "recital"; line: number; heading: string; lines: string[] }
  | {
      type: "clause";
      line: number;
      level: number;
      heading: string;
      lines: string[];
    }
  | { type: "paragraph"; line: number; heading: string; lines: string[] }
  | {
      type: "list";
      line: number;
      ordered: boolean;
      heading: string;
      lines: string[];
    }
  | { type: "table"; line: number; heading: string; lines: string[] }
  | { type: "schedule"; line: number; heading: string; lines: string[] }
  | { type: "signatures"; line: number; heading: string; lines: string[] };

export const parseLegalSource = (
  source: string,
  options: { titleFallback?: string } = {},
): LegalSourceParseResult => {
  const fixes: Autofix[] = [];
  const diagnostics: LegalDraftDiagnostic[] = [];
  const blocks: LegalDraftBlock[] = [];
  const meta: LegalDraft["meta"] = {
    kind: DEFAULT_KIND,
    locale: DEFAULT_LOCALE,
    numbering: DEFAULT_NUMBERING,
    page: {
      size: DEFAULT_PAGE_SIZE,
      orientation: DEFAULT_ORIENTATION,
    },
    title: null as string | null,
  };

  let pending: PendingBlock | null = null;

  const pushPending = () => {
    if (!pending) {
      return;
    }

    const block = pendingToBlock(pending, diagnostics, fixes);
    if (block) {
      blocks.push(block);
      if (block.type === "title") {
        meta.title = block.text;
      }
    }
    pending = null;
  };

  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      pending?.lines.push("");
      continue;
    }

    const markdownHeading = parseMarkdownHeading(trimmed);
    if (markdownHeading) {
      pushPending();
      const { depth, heading } = markdownHeading;
      if (depth === 1) {
        // Title blocks have no body — only the heading text survives
        // through `pendingToBlock`. Flush immediately so subsequent
        // non-directive lines start a fresh paragraph block via the
        // fallback below, instead of silently dropping into the
        // title's discarded `lines` array.
        pending = { type: "title", line: lineNumber, heading, lines: [] };
        pushPending();
      } else {
        pending = {
          type: "clause",
          line: lineNumber,
          level: Math.min(depth - 1, 6),
          heading,
          lines: [],
        };
      }
      fixes.push({
        code: "markdown-heading-normalized",
        message: "Converted a Markdown heading into a legal directive.",
        line: lineNumber,
      });
      continue;
    }

    if (trimmed.startsWith("@")) {
      const [rawDirective = "", ...rest] = trimmed.split(/\s+/);
      const canonicalDirective =
        DIRECTIVE_ALIASES[rawDirective.toLowerCase()] ??
        rawDirective.toLowerCase();
      const argument = rest.join(" ").trim();

      if (!DIRECTIVES.has(canonicalDirective)) {
        diagnostics.push({
          code: "unknown-directive",
          message: `Unknown legal directive "${rawDirective}".`,
          severity: "error",
          line: lineNumber,
        });
        pending?.lines.push(line);
        continue;
      }

      if (canonicalDirective !== rawDirective.toLowerCase()) {
        fixes.push({
          code: "directive-alias-normalized",
          message: `Normalized ${rawDirective} to ${canonicalDirective}.`,
          line: lineNumber,
        });
      }

      pushPending();

      switch (canonicalDirective) {
        case "@doc":
          parseDocDirective(argument, meta, diagnostics, lineNumber);
          break;
        case "@title":
          // Title blocks have no body — flush immediately (same as
          // markdown `# Title`) so the next non-directive line starts
          // a paragraph block instead of dropping into the title's
          // discarded `lines` array.
          pending = {
            type: "title",
            line: lineNumber,
            heading: argument,
            lines: [],
          };
          pushPending();
          break;
        case "@recital":
          pending = {
            type: "recital",
            line: lineNumber,
            heading: argument,
            lines: [],
          };
          break;
        case "@clause":
          pending = {
            type: "clause",
            line: lineNumber,
            level: 1,
            heading: argument,
            lines: [],
          };
          break;
        case "@subclause":
          pending = {
            type: "clause",
            line: lineNumber,
            level: 2,
            heading: argument,
            lines: [],
          };
          break;
        case "@paragraph":
          pending = {
            type: "paragraph",
            line: lineNumber,
            heading: argument,
            lines: [],
          };
          break;
        case "@list":
          pending = {
            type: "list",
            line: lineNumber,
            ordered: /\bordered\b/i.test(argument),
            heading: argument,
            lines: [],
          };
          break;
        case "@table":
          pending = {
            type: "table",
            line: lineNumber,
            heading: argument,
            lines: [],
          };
          break;
        case "@schedule":
          pending = {
            type: "schedule",
            line: lineNumber,
            heading: argument,
            lines: [],
          };
          break;
        case "@signatures":
          pending = {
            type: "signatures",
            line: lineNumber,
            heading: argument,
            lines: [],
          };
          break;
        case "@pagebreak":
          blocks.push({ type: "pageBreak" });
          break;
        default:
          break;
      }
      continue;
    }

    pending ??= { type: "paragraph", line: lineNumber, heading: "", lines: [] };
    pending.lines.push(line);
  }

  pushPending();

  if (!meta.title) {
    const firstTitle = blocks.find((block) => block.type === "title");
    meta.title =
      firstTitle?.type === "title"
        ? firstTitle.text
        : (options.titleFallback ?? "Untitled document");
  }

  const draft: LegalDraft = { meta, blocks };
  return applyDocumentAutofixes({ diagnostics, draft, fixes });
};

const parseDocDirective = (
  argument: string,
  meta: LegalDraft["meta"],
  diagnostics: LegalDraftDiagnostic[],
  line: number,
) => {
  const attrs = parseAttributes(argument);

  const kind = attrs.get("kind");
  if (kind !== undefined && isLegalKind(kind)) {
    meta.kind = kind;
  } else if (kind !== undefined) {
    diagnostics.push({
      code: "invalid-doc-attribute",
      message: `Invalid @doc kind "${kind}".`,
      severity: "warning",
      line,
    });
  }

  const locale = attrs.get("locale");
  if (locale) {
    meta.locale = locale;
  }

  const numbering = attrs.get("numbering");
  if (numbering !== undefined && isNumberingProfile(numbering)) {
    meta.numbering = numbering;
  } else if (numbering !== undefined) {
    diagnostics.push({
      code: "invalid-doc-attribute",
      message: `Invalid @doc numbering "${numbering}".`,
      severity: "warning",
      line,
    });
  }

  const page = attrs.get("page");
  if (page !== undefined && isPageSize(page)) {
    meta.page.size = page;
  } else if (page !== undefined) {
    diagnostics.push({
      code: "invalid-doc-attribute",
      message: `Invalid @doc page "${page}".`,
      severity: "warning",
      line,
    });
  }

  const orientation = attrs.get("orientation");
  if (orientation !== undefined && isPageOrientation(orientation)) {
    meta.page.orientation = orientation;
  } else if (orientation !== undefined) {
    diagnostics.push({
      code: "invalid-doc-attribute",
      message: `Invalid @doc orientation "${orientation}".`,
      severity: "warning",
      line,
    });
  }

  const title = attrs.get("title");
  if (title) {
    meta.title = title;
  }

  for (const key of attrs.keys()) {
    if (
      !["kind", "locale", "numbering", "page", "orientation", "title"].includes(
        key,
      )
    ) {
      diagnostics.push({
        code: "unknown-doc-attribute",
        message: `Unknown @doc attribute "${key}".`,
        severity: "warning",
        line,
      });
    }
  }
};

const parseAttributes = (value: string): Map<string, string> => {
  const attrs = new Map<string, string>();
  let index = 0;

  while (index < value.length) {
    const attr = readAttribute(value, index);
    if (!attr) {
      index = skipMalformedAttribute(value, index);
      continue;
    }

    attrs.set(attr.key, attr.value);
    index = attr.nextIndex;
  }
  return attrs;
};

type ParsedAttribute = {
  key: string;
  value: string;
  nextIndex: number;
};

const readAttribute = (
  value: string,
  startIndex: number,
): ParsedAttribute | null => {
  const keyStart = skipWhitespace(value, startIndex);
  const keyEnd = readAttributeKeyEnd(value, keyStart);
  const key = value.slice(keyStart, keyEnd).toLowerCase();
  const equalsIndex = skipWhitespace(value, keyEnd);
  if (!key || value.charAt(equalsIndex) !== "=") {
    return null;
  }

  const attributeValue = readAttributeValue(
    value,
    skipWhitespace(value, equalsIndex + 1),
  );
  return {
    key,
    value: attributeValue.value,
    nextIndex: attributeValue.nextIndex,
  };
};

const skipWhitespace = (value: string, startIndex: number): number => {
  let index = startIndex;
  while (index < value.length && isWhitespace(value.charAt(index))) {
    index++;
  }
  return index;
};

const readAttributeKeyEnd = (value: string, startIndex: number): number => {
  let index = startIndex;
  while (index < value.length && isAttributeKeyChar(value.charAt(index))) {
    index++;
  }
  return index;
};

const readAttributeValue = (
  value: string,
  startIndex: number,
): { value: string; nextIndex: number } => {
  const quote = value.charAt(startIndex);
  if (quote === '"' || quote === "'") {
    return readQuotedAttributeValue(value, startIndex + 1, quote);
  }

  let index = startIndex;
  while (index < value.length && !isWhitespace(value.charAt(index))) {
    index++;
  }
  return { value: value.slice(startIndex, index), nextIndex: index };
};

const readQuotedAttributeValue = (
  value: string,
  startIndex: number,
  quote: string,
): { value: string; nextIndex: number } => {
  let index = startIndex;
  while (index < value.length && value.charAt(index) !== quote) {
    index++;
  }
  return {
    value: value.slice(startIndex, index),
    nextIndex: index < value.length ? index + 1 : index,
  };
};

const skipMalformedAttribute = (value: string, startIndex: number): number => {
  let index = skipWhitespace(value, startIndex);
  while (index < value.length && !isWhitespace(value.charAt(index))) {
    index++;
  }
  return index === startIndex ? index + 1 : index;
};

const isWhitespace = (char: string): boolean =>
  char === " " || char === "\t" || char === "\r" || char === "\n";

const isAttributeKeyChar = (char: string): boolean =>
  isAsciiAlphaNumeric(char) || char === "_" || char === "." || char === "-";

const isAsciiAlphaNumeric = (char: string): boolean => {
  const code = char.codePointAt(0);
  if (code === undefined) {
    return false;
  }
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
};

const parseMarkdownHeading = (
  line: string,
): { depth: number; heading: string } | null => {
  let depth = 0;
  for (const char of line) {
    if (char !== "#") {
      break;
    }
    depth++;
  }

  if (depth < 1 || depth > 6 || line.at(depth) !== " ") {
    return null;
  }

  const heading = line.slice(depth + 1).trim();
  return heading ? { depth, heading } : null;
};

const pendingToBlock = (
  pending: PendingBlock,
  diagnostics: LegalDraftDiagnostic[],
  fixes: Autofix[],
): LegalDraftBlock | null => {
  switch (pending.type) {
    case "title": {
      const text = pending.heading || paragraphText(pending.lines);
      if (!text) {
        return null;
      }
      return { type: "title", text };
    }
    case "recital":
      return { type: "recital", paragraphs: compactParagraphs(pending.lines) };
    case "clause": {
      const heading = stripManualNumbering(
        pending.heading,
        pending.line,
        fixes,
      );
      // The AI sometimes uses `@clause` as a generic "section"
      // wrapper without giving it a title. Rather than rejecting,
      // downgrade to a plain paragraph block — same body content,
      // no clause numbering or heading row. The fix log keeps the
      // event visible without blocking compile.
      if (!heading) {
        fixes.push({
          code: "headingless-clause-downgraded",
          message: "Converted a headingless @clause into a paragraph block.",
          line: pending.line,
        });
        return {
          type: "paragraph",
          paragraphs: compactParagraphs(pending.lines),
        };
      }
      return {
        type: "clause",
        level: pending.level,
        heading,
        paragraphs: compactParagraphs(pending.lines),
      };
    }
    case "paragraph":
      return {
        type: "paragraph",
        paragraphs: compactParagraphs(pending.lines),
      };
    case "list":
      return {
        type: "list",
        ordered: pending.ordered,
        items: pending.lines
          .map((line) => stripListMarker(line, pending.ordered))
          .filter(Boolean),
      };
    case "table":
      return parseTableBlock(pending, diagnostics, fixes);
    case "schedule": {
      const heading = stripManualNumbering(
        pending.heading,
        pending.line,
        fixes,
      );
      return {
        type: "schedule",
        heading,
        paragraphs: compactParagraphs(pending.lines),
      };
    }
    case "signatures":
      return {
        type: "signatures",
        parties: parseSignatureParties(pending.lines, pending.heading),
      };
    default:
      pending satisfies never;
      return null;
  }
};

const parseTableBlock = (
  pending: Extract<PendingBlock, { type: "table" }>,
  diagnostics: LegalDraftDiagnostic[],
  fixes: Autofix[],
): LegalDraftBlock => {
  const tableLines = pending.lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));
  const rows = tableLines.map(parsePipeRow).filter((row) => row.length > 0);

  const header = rows.at(0) ?? [];
  const bodyRows = rows.slice(1).filter((row) => !isMarkdownDividerRow(row));
  const normalizedRows = bodyRows.map((row) => {
    if (row.length === header.length) {
      return row;
    }
    fixes.push({
      code: "table-row-width-normalized",
      message: "Normalized a table row to match the header width.",
      line: pending.line,
    });
    return header.map((_, index) => row.at(index) ?? "");
  });

  if (header.length === 0) {
    diagnostics.push({
      code: "missing-table-header",
      message: "Table directives must include a pipe-table header row.",
      severity: "error",
      line: pending.line,
    });
  }

  return {
    type: "table",
    table: {
      headers: header,
      rows: normalizedRows,
    },
  };
};

const applyDocumentAutofixes = ({
  diagnostics,
  draft,
  fixes,
}: {
  diagnostics: LegalDraftDiagnostic[];
  draft: LegalDraft;
  fixes: Autofix[];
}): LegalSourceParseResult => {
  const blocks: LegalDraftBlock[] = [];

  for (const block of draft.blocks) {
    if (
      block.type === "clause" &&
      block.level === 1 &&
      normalizeTitle(block.heading) === normalizeTitle(draft.meta.title ?? "")
    ) {
      fixes.push({
        code: "duplicate-title-clause-removed",
        message: "Removed a first clause that duplicated the document title.",
      });
      continue;
    }
    blocks.push(block);
  }

  const signatureIndex = blocks.findIndex(
    (block) => block.type === "signatures",
  );
  if (signatureIndex !== -1 && signatureIndex !== blocks.length - 1) {
    const [signatureBlock] = blocks.splice(signatureIndex, 1);
    if (signatureBlock) {
      blocks.push(signatureBlock);
      fixes.push({
        code: "signatures-moved-to-end",
        message: "Moved the signatures block to the end of the document.",
      });
    }
  }

  return {
    draft: { ...draft, blocks },
    diagnostics,
    fixes,
  };
};

// Localized aliases for `@signatures` field keys. Lets the AI
// write `strana:` / `funkce:` etc. when the document is in Czech
// without forcing a separate parser per language. Add new aliases
// here as locales come online — the canonical (English) keys are
// what the rest of the parser branches on.
const SIGNATURE_KEY_ALIASES: Record<string, string> = {
  // Canonical
  party: "party",
  by: "by",
  name: "name",
  title: "title",
  date: "date",
  // Czech / Slovak
  strana: "party",
  podepisuje: "by",
  podpisuje: "by",
  jméno: "name",
  jmeno: "name",
  meno: "name",
  funkce: "title",
  funkcia: "title",
  datum: "date",
  // German
  partei: "party",
  unterzeichnet: "by",
  unterschreibt: "by",
  funktion: "title",
  // French
  partie: "party",
  signataire: "by",
  nom: "name",
  fonction: "title",
  // Spanish
  parte: "party",
  firmante: "by",
  nombre: "name",
  cargo: "title",
  fecha: "date",
  // Italian
  firmatario: "by",
  nome: "name",
  carica: "title",
  data: "date",
  // Polish
  imie: "name",
  imię: "name",
  stanowisko: "title",
  // Portuguese
  assinante: "by",
  // Dutch
  ondertekent: "by",
  naam: "name",
  functie: "title",
  // Hungarian
  fél: "party",
  fel: "party",
  aláírja: "by",
  alairja: "by",
  név: "name",
  nev: "name",
  beosztás: "title",
  beosztas: "title",
  dátum: "date",
};
const SIGNATURE_FIELD_KEYS = new Set(["party", "by", "name", "title", "date"]);

const parseSignatureParties = (
  lines: string[],
  heading: string,
): LegalSignatureParty[] => {
  const parties: LegalSignatureParty[] = [];
  let current: LegalSignatureParty | null = null;

  const pushCurrent = () => {
    if (!current?.name.trim()) {
      current = null;
      return;
    }
    parties.push({
      name: current.name.trim(),
      ...(current.signatory ? { signatory: current.signatory.trim() } : {}),
      ...(current.title ? { title: current.title.trim() } : {}),
    });
    current = null;
  };

  const startParty = (name: string) => {
    pushCurrent();
    current = { name };
  };

  if (heading.trim()) {
    startParty(heading.trim().replace(/^party:\s*/i, ""));
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex === -1) {
      startParty(trimmed);
      continue;
    }

    const rawKey = trimmed.slice(0, separatorIndex).toLowerCase();
    const canonicalKey = SIGNATURE_KEY_ALIASES[rawKey];
    if (!canonicalKey || !SIGNATURE_FIELD_KEYS.has(canonicalKey)) {
      startParty(trimmed);
      continue;
    }

    const value = trimmed.slice(separatorIndex + 1).trim();
    if (canonicalKey === "party") {
      startParty(value);
      continue;
    }
    current ??= { name: "" };
    if ((canonicalKey === "by" || canonicalKey === "name") && value) {
      current.signatory = value;
    }
    if (canonicalKey === "title" && value) {
      current.title = value;
    }
  }

  pushCurrent();

  const seen = new Set<string>();
  return parties.filter((party) => {
    const key = `${party.name}\u0000${party.signatory ?? ""}\u0000${party.title ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const stripListMarker = (line: string, ordered: boolean): string => {
  const trimmed = line.trim();
  if (ordered) {
    return trimmed.replace(/^\d+(?:\.\d+)*[.)]?\s+/, "");
  }
  return trimmed.replace(/^[-*•]\s+/, "");
};

const parsePipeRow = (line: string): string[] =>
  line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

const isMarkdownDividerRow = (row: string[]): boolean =>
  row.every((cell) => /^:?-{3,}:?$/.test(cell));

const compactParagraphs = (lines: string[]): string[] => {
  const paragraphs: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(trimmed);
  }

  if (current.length > 0) {
    paragraphs.push(current.join(" "));
  }

  return paragraphs;
};

const paragraphText = (lines: string[]): string =>
  compactParagraphs(lines).join(" ");

const stripManualNumbering = (
  value: string,
  line: number,
  fixes: Autofix[],
): string => {
  // Numeric and letter branches both require a delimiter so legit
  // headings starting with a year or single-word capital
  // ("2024 Compliance Obligations", "A Party's Obligations") are
  // not silently rewritten:
  //   - `\d+(?:\.\d+)+` accepts multi-level numbers (1.1, 1.1.1)
  //     where the dot itself is the delimiter.
  //   - `\d+[.)]` accepts a single number followed by '.' or ')'.
  //   - `[A-Za-z][.)]` accepts a letter followed by '.' or ')'.
  //   - `\([a-zivx]+\)` accepts parenthesised letters/roman.
  const stripped = value
    .trim()
    .replace(/^(\d+(?:\.\d+)+|\d+[.)]|[A-Za-z][.)]|\([a-zivx]+\))\s+/, "");
  if (stripped !== value.trim()) {
    fixes.push({
      code: "manual-numbering-stripped",
      message: "Removed manual numbering from a directive heading.",
      line,
    });
  }
  return stripped;
};

const normalizeTitle = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const isLegalKind = (value: string | undefined): value is LegalDocumentKind =>
  value === "agreement" ||
  value === "letter" ||
  value === "memo" ||
  value === "checklist" ||
  value === "pleading" ||
  value === "other";

const isNumberingProfile = (
  value: string | undefined,
): value is LegalNumberingProfile =>
  value === "legal" || value === "none" || value === "checklist";

const isPageSize = (value: string | undefined): value is LegalPageSize =>
  value === "A4" || value === "Letter";

const isPageOrientation = (
  value: string | undefined,
): value is LegalPageOrientation =>
  value === "portrait" || value === "landscape";
