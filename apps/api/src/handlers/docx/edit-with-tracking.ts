/**
 * Top-level orchestrator for mode (c): tracked-changes editing.
 *
 * Opens a DOCX, applies edits as tracked changes, optionally
 * injects comments, enables review mode in settings, and
 * returns the modified buffer.
 */

import { Result } from "better-result";
import * as slimdom from "slimdom";

import { loadDocxArchive } from "@/api/lib/docx-archive";
import { DocxEditError } from "@/api/lib/errors/tagged-errors";

import { applyEdits } from "./apply-edits";
import { injectComments } from "./inject-comments";
import {
  collectExistingIds,
  createIdGenerator,
  isElement,
  W_NS,
} from "./ooxml";
import type { DocxEditSet, EditWithTrackingResult } from "./types";
import { validateOoxml } from "./validate-ooxml";

// ── Content-type and rels constants ───────────────────────

const COMMENTS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument" +
  ".wordprocessingml.comments+xml";

const COMMENTS_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";

// ── Settings: enable track-revisions ──────────────────────

const SETTINGS_OPEN_RE = /(<w:settings\b[^>]*>)/u;

const ensureTrackRevisions = (settingsXml: string): string => {
  if (settingsXml.includes("w:trackRevisions")) {
    return settingsXml;
  }

  // Insert <w:trackRevisions/> as first child of w:settings
  return settingsXml.replace(SETTINGS_OPEN_RE, "$1<w:trackRevisions/>");
};

// ── Content types: ensure comments entry exists ───────────

const ensureCommentsContentType = (contentTypesXml: string): string => {
  if (contentTypesXml.includes("comments+xml")) {
    return contentTypesXml;
  }

  return contentTypesXml.replace(
    "</Types>",
    `<Override PartName="/word/comments.xml" ` +
      `ContentType="${COMMENTS_CONTENT_TYPE}"/></Types>`,
  );
};

// ── Rels: ensure comments relationship exists ─────────────

const ensureCommentsRel = (relsXml: string): string => {
  if (relsXml.includes('Target="comments.xml"')) {
    return relsXml;
  }

  // Find the highest rId to generate a new unique one
  const idMatches = [...relsXml.matchAll(/rId(\d+)/gu)];
  let maxId = 0;
  for (const match of idMatches) {
    maxId = Math.max(maxId, Number.parseInt(match[1] ?? "0", 10));
  }
  const newId = `rId${maxId + 1}`;

  return relsXml.replace(
    "</Relationships>",
    `<Relationship Id="${newId}" ` +
      `Type="${COMMENTS_REL_TYPE}" ` +
      `Target="comments.xml"/></Relationships>`,
  );
};

// ── Main orchestrator ─────────────────────────────────────

export const editWithTracking = async (
  docxBuffer: Buffer,
  editSet: DocxEditSet,
): Promise<Result<EditWithTrackingResult, DocxEditError>> =>
  await Result.tryPromise({
    try: async () => {
      const archive = await loadDocxArchive(docxBuffer);
      const { zip } = archive;

      // 1. Read document.xml
      let documentXml = await archive.readEntryString("word/document.xml");
      if (documentXml === null) {
        throw new DocxEditError({
          message: "Invalid DOCX: missing word/document.xml",
          cause: null,
        });
      }

      // 2. Collect existing IDs, count paragraphs
      const doc = slimdom.parseXmlDocument(documentXml);
      const existingIds = collectExistingIds(doc);
      const idGenerator = createIdGenerator(existingIds);

      const body = doc.getElementsByTagNameNS(W_NS, "body").at(0);
      let paraCount = 0;
      if (body) {
        for (const child of body.childNodes) {
          if (!isElement(child)) {
            continue;
          }
          if (child.localName === "p" && child.namespaceURI === W_NS) {
            paraCount++;
          }
        }
      }

      // 3. Check for out-of-range paragraph indices
      const skippedEdits = [
        ...new Set(
          editSet.edits
            .filter((e) => e.paragraphIndex >= paraCount)
            .map((e) => e.paragraphIndex),
        ),
      ];
      const skippedComments = [
        ...new Set(
          editSet.comments
            .filter((c) => c.paragraphIndex >= paraCount)
            .map((c) => c.paragraphIndex),
        ),
      ];

      // 4. Apply edits (filter out-of-range to avoid wasting IDs)
      const validEdits = editSet.edits.filter(
        (e) => e.paragraphIndex < paraCount,
      );
      if (validEdits.length > 0) {
        documentXml = applyEdits(
          documentXml,
          validEdits,
          editSet.author,
          idGenerator,
        );
      }

      // 5. Inject comments (filter out-of-range like edits)
      const validComments = editSet.comments.filter(
        (c) => c.paragraphIndex < paraCount,
      );
      const hasComments = validComments.length > 0;
      if (hasComments) {
        const existingComments =
          await archive.readEntryString("word/comments.xml");

        const result = injectComments(
          documentXml,
          existingComments,
          validComments,
          editSet.author,
          idGenerator,
        );

        documentXml = result.documentXml;
        zip.file("word/comments.xml", result.commentsXml);
      }

      // 6. Validate OOXML structure (non-blocking)
      const validation = validateOoxml(documentXml);

      // 7. Write modified document.xml
      zip.file("word/document.xml", documentXml);

      // 8. Enable track revisions in settings
      const settingsXml = await archive.readEntryString("word/settings.xml");
      if (settingsXml !== null) {
        zip.file("word/settings.xml", ensureTrackRevisions(settingsXml));
      }

      // 9. Update content types and rels for comments
      if (hasComments) {
        const ctXml = await archive.readEntryString("[Content_Types].xml");
        if (ctXml !== null) {
          zip.file("[Content_Types].xml", ensureCommentsContentType(ctXml));
        }

        const relsXml = await archive.readEntryString(
          "word/_rels/document.xml.rels",
        );
        if (relsXml !== null) {
          zip.file("word/_rels/document.xml.rels", ensureCommentsRel(relsXml));
        }
      }

      // 10. Generate output buffer
      const output = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
      });

      return {
        buffer: Buffer.from(output),
        skippedEdits,
        skippedComments,
        validationViolations: validation.valid
          ? undefined
          : validation.violations,
      };
    },
    catch: (error) =>
      DocxEditError.is(error)
        ? error
        : new DocxEditError({
            message: "Failed to apply tracked changes to DOCX",
            cause: error,
          }),
  });
