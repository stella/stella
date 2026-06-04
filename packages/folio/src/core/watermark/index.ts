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
 * A typed header is only created for a section that cannot inherit one of that
 * type from itself or a preceding section (Word inherits forward only), so
 * existing headers — and the watermark already written to them — are preserved.
 * Created headers use freshly minted rIds that the save pipeline materializes
 * into real parts.
 */
export function ensureWatermarkHeaderCoverage(
  doc: Document,
  watermark: Watermark,
): Document {
  const body = doc.package.document;
  const headers = new Map<string, HeaderFooter>(doc.package.headers);
  const evenOddMode = doc.package.settings?.evenAndOddHeaders === true;

  const resolvesType = (
    props: SectionProperties,
    type: HeaderFooterType,
  ): boolean =>
    props.headerReferences?.some(
      (ref) => ref.type === type && headers.has(ref.rId),
    ) ?? false;

  // Mint a coverage rId that collides with no existing relationship, header, or
  // footer id (a fixed id could clash with a producer-chosen one and corrupt
  // the saved package). Memoized per type so all sections needing the same type
  // share one coverage header.
  const usedRIds = new Set<string>([
    ...(doc.package.relationships?.keys() ?? []),
    ...headers.keys(),
    ...(doc.package.footers?.keys() ?? []),
  ]);
  const coverageRIdByType = new Map<HeaderFooterType, string>();
  const coverageRId = (type: HeaderFooterType): string => {
    const existing = coverageRIdByType.get(type);
    if (existing !== undefined) {
      return existing;
    }
    let candidate = `rId_wm_${type}`;
    let suffix = 1;
    while (usedRIds.has(candidate)) {
      suffix += 1;
      candidate = `rId_wm_${type}_${suffix}`;
    }
    usedRIds.add(candidate);
    coverageRIdByType.set(type, candidate);
    return candidate;
  };

  // Sections in document order: mid-body section breaks (paragraph sectPr)
  // first, then the body's final sectPr. `blockIndex` ties a slot back to the
  // paragraph it came from for the rebuild; the final section has none.
  type Slot = { props: SectionProperties; blockIndex: number | null };
  const slots: Slot[] = [];
  for (const [index, block] of body.content.entries()) {
    if (block.type === "paragraph" && block.sectionProperties) {
      slots.push({ props: block.sectionProperties, blockIndex: index });
    }
  }
  slots.push({ props: body.finalSectionProperties ?? {}, blockIndex: null });

  // Word inherits headers forward only: a section uses its own typed reference
  // or the nearest preceding section's. Walk in document order tracking whether
  // a resolvable header of each type is in effect; the first section that needs
  // the type but cannot inherit one gets a coverage reference, after which
  // later sections inherit it. (A backward-inheriting global check would miss a
  // cover/even page that precedes the first existing typed header.)
  type Ref = { type: HeaderFooterType; rId: string };
  const additions: Ref[][] = slots.map(() => []);
  const planType = (
    type: HeaderFooterType,
    sectionNeedsType: (props: SectionProperties) => boolean,
  ): void => {
    let inherited = false;
    for (const [index, slot] of slots.entries()) {
      if (resolvesType(slot.props, type)) {
        inherited = true;
        continue;
      }
      if (sectionNeedsType(slot.props) && !inherited) {
        additions[index]?.push({ type, rId: coverageRId(type) });
        inherited = true;
      }
    }
  };

  // Normal pages (default), cover pages (first under titlePg), and even pages
  // (under evenAndOddHeaders) each get coverage where a section cannot inherit
  // that header type forward. Default runs unconditionally so a section that
  // precedes the first existing default header — or a header-less document — is
  // still covered.
  planType("default", () => true);
  planType("first", (props) => props.titlePg === true);
  if (evenOddMode) {
    planType("even", () => true);
  }

  if (additions.every((refs) => refs.length === 0)) {
    return doc;
  }

  // Materialize the coverage headers actually referenced (one per minted rId).
  const coverageTypeByRId = new Map<string, HeaderFooterType>();
  for (const ref of additions.flat()) {
    coverageTypeByRId.set(ref.rId, ref.type);
  }
  for (const [rId, type] of coverageTypeByRId) {
    if (!headers.has(rId)) {
      headers.set(rId, {
        type: "header",
        hdrFtrType: type,
        content: [],
        watermark: { ...watermark },
      });
    }
  }

  const withRefs = (props: SectionProperties, refs: Ref[]): SectionProperties =>
    refs.length === 0
      ? props
      : {
          ...props,
          headerReferences: [...(props.headerReferences ?? []), ...refs],
        };

  const additionsByBlock = new Map<number, Ref[]>();
  for (const [index, slot] of slots.entries()) {
    if (slot.blockIndex !== null) {
      additionsByBlock.set(slot.blockIndex, additions[index] ?? []);
    }
  }

  const newContent = body.content.map((block, index) => {
    const refs = additionsByBlock.get(index);
    if (
      block.type === "paragraph" &&
      block.sectionProperties &&
      refs !== undefined &&
      refs.length > 0
    ) {
      return {
        ...block,
        sectionProperties: withRefs(block.sectionProperties, refs),
      };
    }
    return block;
  });
  // The final section is always the last slot.
  const newFinal = withRefs(
    body.finalSectionProperties ?? {},
    additions.at(-1) ?? [],
  );

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
