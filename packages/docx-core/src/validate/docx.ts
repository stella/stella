import JSZip from "jszip";

import type {
  BlockContent,
  Comment,
  Document,
  HeaderFooter,
  HeaderFooterType,
  Hyperlink,
  Image,
  Paragraph,
  ParagraphContent,
  Run,
  RunContent,
  SectionProperties,
  Shape,
  Table,
  TableCell,
  TableRow,
  TrackedRunChange,
} from "../model/document";

export type ValidateDocxPackageResult =
  | { valid: true }
  | { valid: false; error: string };

export type ValidateDocumentModelIssue = {
  path: string;
  message: string;
  severity: "error" | "warning";
};

export type ValidateDocumentModelResult = {
  valid: boolean;
  issues: ValidateDocumentModelIssue[];
};

export const validateDocxPackage = async (
  buffer: ArrayBuffer | Uint8Array,
): Promise<ValidateDocxPackageResult> => {
  try {
    const zip = await JSZip.loadAsync(buffer);
    for (const requiredPath of [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/styles.xml",
      "word/_rels/document.xml.rels",
    ]) {
      if (!zip.file(requiredPath)) {
        return {
          valid: false,
          error: `Generated DOCX is missing required package part: ${requiredPath}`,
        };
      }
    }

    const documentXml = await zip.file("word/document.xml")?.async("string");
    if (!documentXml?.includes("<w:document")) {
      return {
        valid: false,
        error: "Generated DOCX has no word/document.xml root document.",
      };
    }

    const documentRelsXml = await zip
      .file("word/_rels/document.xml.rels")
      ?.async("string");
    if (
      documentRelsXml?.includes("/relationships/numbering") &&
      !zip.file("word/numbering.xml")
    ) {
      return {
        valid: false,
        error:
          "Generated DOCX references numbering.xml but does not include it.",
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Invalid DOCX package.",
    };
  }
};

type CounterMap = Map<number, number>;

type ValidationContext = {
  issues: ValidateDocumentModelIssue[];
  commentIds: Set<number>;
  referencedCommentIds: Map<number, string[]>;
  commentRangeStarts: CounterMap;
  commentRangeEnds: CounterMap;
  bookmarkStarts: CounterMap;
  bookmarkEnds: CounterMap;
  moveFromStarts: CounterMap;
  moveFromEnds: CounterMap;
  moveToStarts: CounterMap;
  moveToEnds: CounterMap;
  noteRefs: {
    footnote: Map<number, string[]>;
    endnote: Map<number, string[]>;
  };
  paraIds: Map<string, string>;
  numberingNums: Set<number>;
  headers: Map<string, HeaderFooter> | undefined;
  footers: Map<string, HeaderFooter> | undefined;
};

export const validateDocumentModel = (
  document: Document,
): ValidateDocumentModelResult => {
  const ctx = createValidationContext(document);
  validateBlocks(
    document.package.document.content,
    "package.document.content",
    ctx,
  );

  validateHeaderFooterMap(document.package.headers, "package.headers", ctx);
  validateHeaderFooterMap(document.package.footers, "package.footers", ctx);
  validateComments(document.package.document.comments ?? [], ctx);
  validateNotes(document, ctx);
  validateMedia(document, ctx);
  validateCounterPairs(ctx.commentRangeStarts, ctx.commentRangeEnds, {
    label: "comment range",
    startName: "commentRangeStart",
    endName: "commentRangeEnd",
    ctx,
  });
  validateCounterPairs(ctx.bookmarkStarts, ctx.bookmarkEnds, {
    label: "bookmark",
    startName: "bookmarkStart",
    endName: "bookmarkEnd",
    ctx,
  });
  validateCounterPairs(ctx.moveFromStarts, ctx.moveFromEnds, {
    label: "move-from range",
    startName: "moveFromRangeStart",
    endName: "moveFromRangeEnd",
    ctx,
  });
  validateCounterPairs(ctx.moveToStarts, ctx.moveToEnds, {
    label: "move-to range",
    startName: "moveToRangeStart",
    endName: "moveToRangeEnd",
    ctx,
  });

  const hasErrors = ctx.issues.some((issue) => issue.severity === "error");
  return {
    valid: !hasErrors,
    issues: ctx.issues,
  };
};

export const assertValidDocumentModel = (document: Document): void => {
  const result = validateDocumentModel(document);
  if (result.valid) {
    return;
  }

  const details = result.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid DOCX document model:\n${details}`);
};

const createValidationContext = (document: Document): ValidationContext => ({
  issues: [],
  commentIds: new Set(
    (document.package.document.comments ?? []).map((comment) => comment.id),
  ),
  referencedCommentIds: new Map(),
  commentRangeStarts: new Map(),
  commentRangeEnds: new Map(),
  bookmarkStarts: new Map(),
  bookmarkEnds: new Map(),
  moveFromStarts: new Map(),
  moveFromEnds: new Map(),
  moveToStarts: new Map(),
  moveToEnds: new Map(),
  noteRefs: {
    footnote: new Map(),
    endnote: new Map(),
  },
  paraIds: new Map(),
  numberingNums: new Set(
    (document.package.numbering?.nums ?? []).map((num) => num.numId),
  ),
  headers: document.package.headers,
  footers: document.package.footers,
});

const addIssue = (
  ctx: ValidationContext,
  issue: ValidateDocumentModelIssue,
): void => {
  ctx.issues.push(issue);
};

const addError = (
  ctx: ValidationContext,
  path: string,
  message: string,
): void => {
  addIssue(ctx, { path, message, severity: "error" });
};

const addWarning = (
  ctx: ValidationContext,
  path: string,
  message: string,
): void => {
  addIssue(ctx, { path, message, severity: "warning" });
};

const increment = (map: CounterMap, id: number): void => {
  map.set(id, (map.get(id) ?? 0) + 1);
};

const recordPath = (
  map: Map<number, string[]>,
  id: number,
  path: string,
): void => {
  const existing = map.get(id);
  if (existing) {
    existing.push(path);
    return;
  }
  map.set(id, [path]);
};

const validateBlocks = (
  blocks: readonly BlockContent[],
  path: string,
  ctx: ValidationContext,
): void => {
  for (const [index, block] of blocks.entries()) {
    validateBlock(block, `${path}[${index}]`, ctx);
  }
};

const validateBlock = (
  block: BlockContent,
  path: string,
  ctx: ValidationContext,
): void => {
  if (block.type === "paragraph") {
    validateParagraph(block, path, ctx);
    return;
  }

  if (block.type === "table") {
    validateTable(block, path, ctx);
    return;
  }

  if (block.content.length === 0) {
    addWarning(ctx, `${path}.content`, "Block content control is empty.");
    return;
  }

  validateBlocks(block.content, `${path}.content`, ctx);
};

const validateParagraph = (
  paragraph: Paragraph,
  path: string,
  ctx: ValidationContext,
): void => {
  if (paragraph.paraId) {
    const existingPath = ctx.paraIds.get(paragraph.paraId);
    if (existingPath) {
      addWarning(
        ctx,
        `${path}.paraId`,
        `Duplicate paragraph id also appears at ${existingPath}.`,
      );
    } else {
      ctx.paraIds.set(paragraph.paraId, path);
    }
  }

  validateNumbering(paragraph, path, ctx);
  if (paragraph.sectionProperties) {
    validateSectionProperties(
      paragraph.sectionProperties,
      `${path}.sectionProperties`,
      ctx,
    );
  }

  for (const [index, content] of paragraph.content.entries()) {
    validateParagraphContent(content, `${path}.content[${index}]`, ctx);
  }
};

const validateParagraphContent = (
  content: ParagraphContent,
  path: string,
  ctx: ValidationContext,
): void => {
  if (content.type === "run") {
    validateRun(content, path, ctx);
    return;
  }

  if (content.type === "hyperlink") {
    validateHyperlink(content, path, ctx);
    return;
  }

  if (content.type === "simpleField") {
    for (const [index, child] of content.content.entries()) {
      validateFieldChild(child, `${path}.content[${index}]`, ctx);
    }
    return;
  }

  if (content.type === "complexField") {
    validateRuns(content.fieldCode, `${path}.fieldCode`, ctx);
    validateRuns(content.fieldResult, `${path}.fieldResult`, ctx);
    return;
  }

  if (content.type === "inlineSdt") {
    for (const [index, child] of content.content.entries()) {
      validateFieldChild(child, `${path}.content[${index}]`, ctx);
    }
    return;
  }

  if (content.type === "commentRangeStart") {
    increment(ctx.commentRangeStarts, content.id);
    recordPath(ctx.referencedCommentIds, content.id, path);
    return;
  }

  if (content.type === "commentRangeEnd") {
    increment(ctx.commentRangeEnds, content.id);
    recordPath(ctx.referencedCommentIds, content.id, path);
    return;
  }

  if (content.type === "commentReference") {
    recordPath(ctx.referencedCommentIds, content.id, path);
    return;
  }

  if (
    content.type === "insertion" ||
    content.type === "deletion" ||
    content.type === "moveFrom" ||
    content.type === "moveTo"
  ) {
    validateTrackedRunChange(content, path, ctx);
    return;
  }

  if (content.type === "bookmarkStart") {
    increment(ctx.bookmarkStarts, content.id);
    return;
  }

  if (content.type === "bookmarkEnd") {
    increment(ctx.bookmarkEnds, content.id);
    return;
  }

  if (content.type === "moveFromRangeStart") {
    increment(ctx.moveFromStarts, content.id);
    return;
  }

  if (content.type === "moveFromRangeEnd") {
    increment(ctx.moveFromEnds, content.id);
    return;
  }

  if (content.type === "moveToRangeStart") {
    increment(ctx.moveToStarts, content.id);
    return;
  }

  if (content.type === "moveToRangeEnd") {
    increment(ctx.moveToEnds, content.id);
    return;
  }

  if (content.ommlXml.trim() === "") {
    addError(ctx, `${path}.ommlXml`, "Math equation must preserve OMML XML.");
  }
};

const validateFieldChild = (
  child: Run | Hyperlink,
  path: string,
  ctx: ValidationContext,
): void => {
  if (child.type === "run") {
    validateRun(child, path, ctx);
    return;
  }

  validateHyperlink(child, path, ctx);
};

const validateRuns = (
  runs: readonly Run[],
  path: string,
  ctx: ValidationContext,
): void => {
  for (const [index, run] of runs.entries()) {
    validateRun(run, `${path}[${index}]`, ctx);
  }
};

const validateRun = (run: Run, path: string, ctx: ValidationContext): void => {
  for (const [index, content] of run.content.entries()) {
    validateRunContent(content, `${path}.content[${index}]`, ctx);
  }
};

const validateRunContent = (
  content: RunContent,
  path: string,
  ctx: ValidationContext,
): void => {
  if (content.type === "drawing") {
    validateImage(content.image, `${path}.image`, ctx);
    return;
  }

  if (content.type === "shape") {
    validateShape(content.shape, `${path}.shape`, ctx);
    return;
  }

  if (content.type === "footnoteRef" || content.type === "endnoteRef") {
    const noteType = content.type === "footnoteRef" ? "footnote" : "endnote";
    recordPath(ctx.noteRefs[noteType], content.id, path);
    return;
  }

  if (content.type === "symbol" && content.char.trim() === "") {
    addError(ctx, `${path}.char`, "Symbol content must include a character.");
  }
};

const validateHyperlink = (
  hyperlink: Hyperlink,
  path: string,
  ctx: ValidationContext,
): void => {
  if (!hyperlink.rId && !hyperlink.href && !hyperlink.anchor) {
    addWarning(
      ctx,
      path,
      "Hyperlink has no relationship, href, or internal anchor.",
    );
  }

  for (const [index, child] of hyperlink.children.entries()) {
    validateHyperlinkChild(child, `${path}.children[${index}]`, ctx);
  }
};

const validateHyperlinkChild = (
  child: Hyperlink["children"][number],
  path: string,
  ctx: ValidationContext,
): void => {
  if (child.type === "run") {
    validateRun(child, path, ctx);
    return;
  }

  if (child.type === "bookmarkStart") {
    increment(ctx.bookmarkStarts, child.id);
    return;
  }

  increment(ctx.bookmarkEnds, child.id);
};

const validateTrackedRunChange = (
  change: TrackedRunChange,
  path: string,
  ctx: ValidationContext,
): void => {
  if (change.info.author.trim() === "") {
    addError(ctx, `${path}.info.author`, "Tracked change author is empty.");
  }

  for (const [index, child] of change.content.entries()) {
    validateFieldChild(child, `${path}.content[${index}]`, ctx);
  }
};

const validateImage = (
  image: Image,
  path: string,
  ctx: ValidationContext,
): void => {
  if (!image.rId && !image.src?.startsWith("data:")) {
    addError(ctx, `${path}.rId`, "Image must have a relationship id.");
  }

  validatePositiveSize(image.size.width, `${path}.size.width`, ctx);
  validatePositiveSize(image.size.height, `${path}.size.height`, ctx);
};

const validateShape = (
  shape: Shape,
  path: string,
  ctx: ValidationContext,
): void => {
  validatePositiveSize(shape.size.width, `${path}.size.width`, ctx);
  validatePositiveSize(shape.size.height, `${path}.size.height`, ctx);

  if (shape.textBody) {
    validateParagraphs(shape.textBody.content, `${path}.textBody.content`, ctx);
  }
};

const validatePositiveSize = (
  value: number,
  path: string,
  ctx: ValidationContext,
): void => {
  if (value <= 0) {
    addError(ctx, path, "Size must be greater than zero.");
  }
};

const validateTable = (
  table: Table,
  path: string,
  ctx: ValidationContext,
): void => {
  if (table.rows.length === 0) {
    addError(ctx, `${path}.rows`, "Table must contain at least one row.");
    return;
  }

  for (const [index, row] of table.rows.entries()) {
    validateTableRow(row, `${path}.rows[${index}]`, ctx);
  }
};

const validateTableRow = (
  row: TableRow,
  path: string,
  ctx: ValidationContext,
): void => {
  if (row.cells.length === 0) {
    addError(ctx, `${path}.cells`, "Table row must contain at least one cell.");
    return;
  }

  for (const [index, cell] of row.cells.entries()) {
    validateTableCell(cell, `${path}.cells[${index}]`, ctx);
  }
};

const validateTableCell = (
  cell: TableCell,
  path: string,
  ctx: ValidationContext,
): void => {
  if (cell.content.length === 0) {
    addError(ctx, `${path}.content`, "Table cell must contain block content.");
    return;
  }

  validateBlocks(cell.content, `${path}.content`, ctx);
};

const validateParagraphs = (
  paragraphs: readonly Paragraph[],
  path: string,
  ctx: ValidationContext,
): void => {
  for (const [index, paragraph] of paragraphs.entries()) {
    validateParagraph(paragraph, `${path}[${index}]`, ctx);
  }
};

const validateNumbering = (
  paragraph: Paragraph,
  path: string,
  ctx: ValidationContext,
): void => {
  const numPr = paragraph.formatting?.numPr;
  if (!numPr) {
    return;
  }

  const ilvl = numPr.ilvl ?? 0;
  if (ilvl < 0 || ilvl > 8) {
    addError(ctx, `${path}.formatting.numPr.ilvl`, "List level must be 0-8.");
  }

  if (numPr.numId === undefined || numPr.numId === 0) {
    return;
  }

  if (!ctx.numberingNums.has(numPr.numId)) {
    addError(
      ctx,
      `${path}.formatting.numPr.numId`,
      `Numbering definition ${numPr.numId} is missing.`,
    );
  }
};

const validateSectionProperties = (
  section: SectionProperties,
  path: string,
  ctx: ValidationContext,
): void => {
  validateHeaderFooterReferences(
    section.headerReferences ?? [],
    ctx.headers,
    `${path}.headerReferences`,
    "header",
    ctx,
  );
  validateHeaderFooterReferences(
    section.footerReferences ?? [],
    ctx.footers,
    `${path}.footerReferences`,
    "footer",
    ctx,
  );
};

const validateHeaderFooterReferences = (
  refs: readonly { type: HeaderFooterType; rId: string }[],
  map: Map<string, HeaderFooter> | undefined,
  path: string,
  label: "header" | "footer",
  ctx: ValidationContext,
): void => {
  for (const [index, ref] of refs.entries()) {
    if (!map?.has(ref.rId)) {
      addError(
        ctx,
        `${path}[${index}].rId`,
        `Section references missing ${label} ${ref.rId}.`,
      );
    }
  }
};

const validateHeaderFooterMap = (
  map: Map<string, HeaderFooter> | undefined,
  path: string,
  ctx: ValidationContext,
): void => {
  if (!map) {
    return;
  }

  for (const [rId, headerFooter] of map.entries()) {
    validateBlocks(headerFooter.content, `${path}.${rId}.content`, ctx);
  }
};

const validateComments = (
  comments: readonly Comment[],
  ctx: ValidationContext,
): void => {
  const seen = new Set<number>();
  for (const [index, comment] of comments.entries()) {
    const path = `package.document.comments[${index}]`;
    if (seen.has(comment.id)) {
      addError(ctx, `${path}.id`, `Duplicate comment id ${comment.id}.`);
    }
    seen.add(comment.id);

    if (comment.author.trim() === "") {
      addError(ctx, `${path}.author`, "Comment author is empty.");
    }

    if (
      comment.parentId !== undefined &&
      !ctx.commentIds.has(comment.parentId)
    ) {
      addError(
        ctx,
        `${path}.parentId`,
        `Parent comment ${comment.parentId} is missing.`,
      );
    }

    validateParagraphs(comment.content, `${path}.content`, ctx);
  }

  for (const [id, paths] of ctx.referencedCommentIds.entries()) {
    if (!ctx.commentIds.has(id)) {
      addError(
        ctx,
        paths.at(0) ?? "package.document",
        `Comment ${id} is referenced but not present in comments.xml.`,
      );
    }
  }
};

const validateNotes = (document: Document, ctx: ValidationContext): void => {
  validateNoteCollection({
    refs: ctx.noteRefs.footnote,
    notes: document.package.footnotes ?? [],
    path: "package.footnotes",
    label: "Footnote",
    ctx,
  });
  validateNoteCollection({
    refs: ctx.noteRefs.endnote,
    notes: document.package.endnotes ?? [],
    path: "package.endnotes",
    label: "Endnote",
    ctx,
  });
};

type ValidateNoteCollectionOptions = {
  refs: Map<number, string[]>;
  notes: readonly { id: number; content: readonly BlockContent[] }[];
  path: string;
  label: "Footnote" | "Endnote";
  ctx: ValidationContext;
};

const validateNoteCollection = ({
  refs,
  notes,
  path,
  label,
  ctx,
}: ValidateNoteCollectionOptions): void => {
  const ids = new Set<number>();
  for (const [index, note] of notes.entries()) {
    if (ids.has(note.id)) {
      addError(
        ctx,
        `${path}[${index}].id`,
        `Duplicate ${label} id ${note.id}.`,
      );
    }
    ids.add(note.id);
    validateBlocks(note.content, `${path}[${index}].content`, ctx);
  }

  for (const [id, paths] of refs.entries()) {
    if (!ids.has(id)) {
      addError(
        ctx,
        paths.at(0) ?? path,
        `${label} ${id} is referenced but not present in the package.`,
      );
    }
  }
};

const validateMedia = (document: Document, ctx: ValidationContext): void => {
  const media = document.package.media;
  if (!media) {
    return;
  }

  for (const [path, file] of media.entries()) {
    const issuePath = `package.media.${path}`;
    if (file.path.trim() === "") {
      addError(ctx, `${issuePath}.path`, "Media file path is empty.");
    }
    if (file.mimeType.trim() === "") {
      addError(ctx, `${issuePath}.mimeType`, "Media MIME type is empty.");
    }
    if (file.data.byteLength === 0) {
      addWarning(ctx, `${issuePath}.data`, "Media file has no binary data.");
    }
  }
};

type ValidateCounterPairsOptions = {
  label: string;
  startName: string;
  endName: string;
  ctx: ValidationContext;
};

const validateCounterPairs = (
  starts: CounterMap,
  ends: CounterMap,
  { label, startName, endName, ctx }: ValidateCounterPairsOptions,
): void => {
  const ids = new Set([...starts.keys(), ...ends.keys()]);
  for (const id of ids) {
    const startCount = starts.get(id) ?? 0;
    const endCount = ends.get(id) ?? 0;
    if (startCount === endCount) {
      continue;
    }

    addError(
      ctx,
      "package.document",
      `Unbalanced ${label} ${id}: ${startName}=${startCount}, ${endName}=${endCount}.`,
    );
  }
};
