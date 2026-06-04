/**
 * Headless API for the document watermark.
 *
 * Mirrors the `content-controls` module's shape: pure functions that
 * read and write a `Document` immutably. Word stores watermarks inside
 * header parts; folio's getter scans every header and returns the
 * first watermark found, and the setter writes the modeled watermark
 * to every header part so all sections render it.
 */

import type {
  Document,
  HeaderFooter,
  HeaderFooterType,
  SectionProperties,
  Watermark,
} from "../types/document";

export type {
  Watermark,
  TextWatermark,
  PictureWatermark,
} from "../types/document";

/**
 * Read the document's watermark. Walks every header part and returns
 * the first watermark encountered (header insertion order). Returns
 * `undefined` when no header carries one.
 */
export function getDocumentWatermark(doc: Document): Watermark | undefined {
  const headers = doc.package.headers;
  if (!headers) {
    return undefined;
  }
  for (const header of headers.values()) {
    if (header.watermark) {
      return header.watermark;
    }
  }
  return undefined;
}

/**
 * Set (or clear) the document's watermark. Writes the modeled `watermark` to
 * every existing header part (clearing the captured raw VML so the serializer
 * synthesizes from the model), then extends coverage to the header parts a
 * document needs but lacks — see {@link ensureWatermarkHeaderCoverage}. Pass
 * `undefined` to remove the watermark from every header.
 */
export function setDocumentWatermark(
  doc: Document,
  watermark: Watermark | undefined,
): Document {
  const headers = doc.package.headers;
  const nextHeaders = new Map<string, HeaderFooter>();
  if (headers) {
    for (const [rId, header] of headers) {
      const next: HeaderFooter = { ...header };
      if (watermark === undefined) {
        delete next.watermark;
        // No watermark left to position — drop the parsed block index too
        // so the serializer doesn't emit at a phantom slot.
        delete next.watermarkBlockIndex;
      } else {
        // Give every header its own watermark object. A picture watermark's
        // `imageRId` is local to each header part's own rels; the package-layer
        // rebind pass at save time rewrites each copy's `imageRId` to a rId
        // that resolves in that header's `word/_rels/header*.xml.rels`. Sharing
        // one object would let that rebind leak across headers.
        next.watermark = { ...watermark };
      }
      // Clear the captured raw VML so the serializer regenerates from the
      // model. Without this, an untouched raw payload would shadow the
      // caller's mutation. `watermarkBlockIndex` is preserved across a
      // text/picture mutation so the new watermark appears at the same
      // flow position as the old one.
      delete next.rawWatermarkXml;
      nextHeaders.set(rId, next);
    }
  }
  const withExisting: Document = {
    ...doc,
    package: { ...doc.package, headers: nextHeaders },
  };
  if (watermark === undefined) {
    return withExisting;
  }
  return ensureWatermarkHeaderCoverage(withExisting, watermark);
}

// Synthetic rIds for coverage-created header parts. They are valid NCNames, so
// they serialize as section `<w:headerReference r:id>` values directly; the
// rezip materialization pass promotes them to real parts + relationships +
// [Content_Types] entries on save.
const COVERAGE_RID: Record<HeaderFooterType, string> = {
  default: "rId_wm_default",
  first: "rId_wm_first",
  even: "rId_wm_even",
};

/**
 * Ensure the watermark shows on every page it should, even when the header
 * parts a section needs are missing:
 *
 * - A document with no headers at all gets a default header carrying the
 *   watermark.
 * - A section with `w:titlePg` but no first-page header gets one (so the
 *   watermark appears on the cover page, which would otherwise be blank).
 * - When `w:evenAndOddHeaders` is on but a section has no even header, one is
 *   created (so even pages are covered).
 *
 * A typed header is only created when no instance of that type exists anywhere
 * in the document, so Word's section-to-section header inheritance — and the
 * watermark already written to those inherited headers — is preserved. Created
 * headers use synthetic rIds that the save pipeline materializes into real
 * parts.
 */
export function ensureWatermarkHeaderCoverage(
  doc: Document,
  watermark: Watermark,
): Document {
  const body = doc.package.document;
  const headers = new Map<string, HeaderFooter>(doc.package.headers);
  const evenOddMode = doc.package.settings?.evenAndOddHeaders === true;
  const noHeadersAtAll = headers.size === 0;

  const resolvesType = (
    props: SectionProperties,
    type: HeaderFooterType,
  ): boolean =>
    props.headerReferences?.some(
      (ref) => ref.type === type && headers.has(ref.rId),
    ) ?? false;

  const allSections: SectionProperties[] = [];
  for (const block of body.content) {
    if (block.type === "paragraph" && block.sectionProperties) {
      allSections.push(block.sectionProperties);
    }
  }
  if (body.finalSectionProperties) {
    allSections.push(body.finalSectionProperties);
  }

  const typeExistsAnywhere = (type: HeaderFooterType): boolean =>
    allSections.some((props) => resolvesType(props, type));

  const needsFirst = (props: SectionProperties): boolean =>
    props.titlePg === true && !resolvesType(props, "first");
  const needsEven = (props: SectionProperties): boolean =>
    evenOddMode && !resolvesType(props, "even");

  const createFirst =
    !typeExistsAnywhere("first") && allSections.some(needsFirst);
  const createEven = !typeExistsAnywhere("even") && allSections.some(needsEven);

  if (!noHeadersAtAll && !createFirst && !createEven) {
    return doc;
  }

  const ensureTypedHeader = (type: HeaderFooterType): string => {
    const rId = COVERAGE_RID[type];
    if (!headers.has(rId)) {
      headers.set(rId, {
        type: "header",
        hdrFtrType: type,
        content: [],
        watermark: { ...watermark },
      });
    }
    return rId;
  };

  const addRef = (
    props: SectionProperties,
    type: HeaderFooterType,
    rId: string,
  ): SectionProperties => ({
    ...props,
    headerReferences: [...(props.headerReferences ?? []), { type, rId }],
  });

  const cover = (props: SectionProperties): SectionProperties => {
    let next = props;
    if (noHeadersAtAll && !resolvesType(next, "default")) {
      next = addRef(next, "default", ensureTypedHeader("default"));
    }
    if (createFirst && needsFirst(props)) {
      next = addRef(next, "first", ensureTypedHeader("first"));
    }
    if (createEven && needsEven(props)) {
      next = addRef(next, "even", ensureTypedHeader("even"));
    }
    return next;
  };

  const newContent = body.content.map((block) =>
    block.type === "paragraph" && block.sectionProperties
      ? { ...block, sectionProperties: cover(block.sectionProperties) }
      : block,
  );
  const newFinal = cover(body.finalSectionProperties ?? {});

  return {
    ...doc,
    package: {
      ...doc.package,
      headers,
      document: {
        ...body,
        content: newContent,
        finalSectionProperties: newFinal,
      },
    },
  };
}
