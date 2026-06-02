/**
 * Hook encapsulating header/footer editing state, content resolution, and
 * mutation callbacks extracted from DocxEditor.
 */

import { useState, useMemo, useCallback } from "react";

import type { EditorView } from "prosemirror-view";

import { proseDocToBlocks } from "../../core/prosemirror/conversion/fromProseDoc";
import type {
  BlockContent,
  Document,
  DocumentBody,
  HeaderFooter,
  SectionProperties,
} from "../../core/types/document";
import type { UseHistoryReturn } from "../../hooks/useHistory";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UseHeaderFooterEditorParams = {
  history: UseHistoryReturn<Document | null>;
  pushDocument: (document: Document) => Document;
  /**
   * Look up the persistent hidden HF EditorView for an rId. Returns null
   * when the view isn't mounted (e.g. the chrome unmounted before the
   * close path ran). Called at close time so the save path can read live
   * PM state and serialise it into the new HeaderFooter without mutating
   * the current history.state.
   */
  getHfView: (rId: string) => EditorView | null;
};

type UseHeaderFooterEditorReturn = {
  /** Which header/footer area is currently being edited, or null */
  hfEditPosition: "header" | "footer" | null;
  setHfEditPosition: (pos: "header" | "footer" | null) => void;
  /** Whether the current HF edit targets the first page */
  hfEditIsFirstPage: boolean;

  /** Resolved header/footer content for the active document */
  headerContent: HeaderFooter | null;
  footerContent: HeaderFooter | null;
  firstPageHeaderContent: HeaderFooter | null;
  firstPageFooterContent: HeaderFooter | null;
  hasTitlePg: boolean;

  /**
   * Relationship ids for the *displayed* H/F slots — same values used to
   * route save/remove (Codex PR #258). The persistent hidden HF PM model
   * looks views up by these rIds; the painter emits them as `data-rid` so
   * the pointer pipeline can route clicks back to the matching view.
   */
  activeHeaderRId: string | null;
  activeFooterRId: string | null;
  activeFirstHeaderRId: string | null;
  activeFirstFooterRId: string | null;

  /** Section properties with titlePg merged from inline sections */
  effectiveSectionProperties: SectionProperties | undefined;

  /** Open the inline HF editor on double-click; creates an empty HF if needed */
  handleHeaderFooterDoubleClick: (
    position: "header" | "footer",
    pageNumber?: number,
  ) => void;
  /**
   * Snapshot the current HF state into a new Document via pushDocument so
   * the edit session lands in undo history. Reads `content` from the
   * active HF PM (via getActiveHfView at hook init) at call time; nothing
   * in `history.state` is mutated until the new Document is pushed.
   */
  handleHeaderFooterSave: () => void;
  /** Save and close HF editor when the body is clicked */
  handleBodyClick: () => void;
  /** Remove the active header/footer from the document */
  handleRemoveHeaderFooter: () => void;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function resolveEffectiveSectionProperties(
  documentBody: DocumentBody | undefined,
  hasTitlePg: boolean,
): SectionProperties | undefined {
  const firstContentSection = documentBody?.sections?.find(
    (section) => section.content.length > 0,
  );
  const base =
    firstContentSection?.properties ?? documentBody?.finalSectionProperties;
  if (!hasTitlePg || base?.titlePg) {
    return base;
  }
  return base ? { ...base, titlePg: true } : base;
}

export const useHeaderFooterEditor = ({
  history,
  pushDocument,
  getHfView,
}: UseHeaderFooterEditorParams): UseHeaderFooterEditorReturn => {
  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const [hfEditPosition, setHfEditPosition] = useState<
    "header" | "footer" | null
  >(null);
  const [hfEditIsFirstPage, setHfEditIsFirstPage] = useState(false);

  // -------------------------------------------------------------------------
  // Resolved header/footer content
  // -------------------------------------------------------------------------

  const {
    headerContent,
    footerContent,
    firstPageHeaderContent,
    firstPageFooterContent,
    hasTitlePg,
    activeHeaderRId,
    activeFooterRId,
    activeFirstHeaderRId,
    activeFirstFooterRId,
  } = useMemo<{
    headerContent: HeaderFooter | null;
    footerContent: HeaderFooter | null;
    firstPageHeaderContent: HeaderFooter | null;
    firstPageFooterContent: HeaderFooter | null;
    hasTitlePg: boolean;
    activeHeaderRId: string | null;
    activeFooterRId: string | null;
    activeFirstHeaderRId: string | null;
    activeFirstFooterRId: string | null;
  }>(() => {
    if (!history.state?.package) {
      return {
        headerContent: null,
        footerContent: null,
        firstPageHeaderContent: null,
        firstPageFooterContent: null,
        hasTitlePg: false,
        activeHeaderRId: null,
        activeFooterRId: null,
        activeFirstHeaderRId: null,
        activeFirstFooterRId: null,
      };
    }

    const pkg = history.state.package;
    const finalProps = pkg.document.finalSectionProperties;
    const sections = pkg.document.sections;
    const headers = pkg.headers;
    const footers = pkg.footers;

    // Collect all section properties (inline sections + final)
    const allSectionProps: SectionProperties[] = [];
    if (sections) {
      for (const s of sections) {
        allSectionProps.push(s.properties);
      }
    } else if (finalProps) {
      allSectionProps.push(finalProps);
    }

    let header: HeaderFooter | null = null;
    let footer: HeaderFooter | null = null;
    let firstHeader: HeaderFooter | null = null;
    let firstFooter: HeaderFooter | null = null;
    let titlePg = false;

    // Resolve default headers/footers: use the last section that defines them
    // (typically the final section properties)
    // Same title-page-section preference as footers below — pages 2+
    // should use the body section's default header, not a later signature
    // section's empty/different one.
    let resolvedHeaderRId: string | null = null;
    let resolvedFooterRId: string | null = null;
    let resolvedFirstHeaderRId: string | null = null;
    let resolvedFirstFooterRId: string | null = null;

    if (headers) {
      let primaryHeaderFromTitleSection: HeaderFooter | null = null;
      let primaryHeaderRId: string | null = null;
      let lastHeader: HeaderFooter | null = null;
      let lastHeaderRId: string | null = null;
      for (const sp of allSectionProps) {
        if (!sp.headerReferences) {
          continue;
        }
        const defaultRef = sp.headerReferences.find(
          (r) => r.type === "default",
        );
        if (!defaultRef?.rId) {
          continue;
        }
        const candidate = headers.get(defaultRef.rId);
        if (!candidate) {
          continue;
        }
        lastHeader = candidate;
        lastHeaderRId = defaultRef.rId;
        // Word only honors `first` references when `<w:titlePg/>` is
        // set on the section (ECMA-376 §17.10.6). A stale `first`
        // reference on a section without titlePg should be ignored —
        // gating on `sp.titlePg` keeps this resolution consistent with
        // the first-page resolution below and with Word's behavior.
        const hasFirstRef =
          sp.titlePg === true &&
          sp.headerReferences.some((r) => r.type === "first");
        if (hasFirstRef && !primaryHeaderFromTitleSection) {
          primaryHeaderFromTitleSection = candidate;
          primaryHeaderRId = defaultRef.rId;
        }
      }
      header = primaryHeaderFromTitleSection ?? lastHeader ?? header;
      resolvedHeaderRId = primaryHeaderRId ?? lastHeaderRId;
    }

    if (footers) {
      // Per ECMA-376 §17.10, each section has its own header/footer
      // references. Folio's HF model is currently flat (one default per
      // document) — the closest spec-conformant approximation is "the
      // section that hosts the title page's first-page references". That's
      // section 1 in NVCA-style multi-section docs (sec 1: title page +
      // body, sec 2..N: signature pages with different / empty footers).
      // Picking the LAST section's default (the previous behavior) silently
      // dropped the body footer's PAGE field on pages 2+ when later
      // sections override `default` with a stripped-down footer.
      //
      // Algorithm: pick the default from the FIRST section that has both
      // a first-page reference AND a default — that's the title-page
      // section, whose default applies to pages 2+ within that section
      // (and, since folio's HF is flat, to pages 2+ globally). Fall back
      // to the last default if no section has both.
      let primaryFooterFromTitleSection: HeaderFooter | null = null;
      let primaryFooterRId: string | null = null;
      let lastFooter: HeaderFooter | null = null;
      let lastFooterRId: string | null = null;
      for (const sp of allSectionProps) {
        if (!sp.footerReferences) {
          continue;
        }
        const defaultRef = sp.footerReferences.find(
          (r) => r.type === "default",
        );
        if (!defaultRef?.rId) {
          continue;
        }
        const candidate = footers.get(defaultRef.rId);
        if (!candidate) {
          continue;
        }
        lastFooter = candidate;
        lastFooterRId = defaultRef.rId;
        // Same titlePg gate as headers above — ignore `first` refs in
        // sections that don't enable title-page mode.
        const hasFirstRef =
          sp.titlePg === true &&
          sp.footerReferences.some((r) => r.type === "first");
        if (hasFirstRef && !primaryFooterFromTitleSection) {
          primaryFooterFromTitleSection = candidate;
          primaryFooterRId = defaultRef.rId;
        }
      }
      footer = primaryFooterFromTitleSection ?? lastFooter ?? footer;
      resolvedFooterRId = primaryFooterRId ?? lastFooterRId;
    }

    // Resolve first-page headers/footers: find the first section with titlePg
    for (const sp of allSectionProps) {
      if (sp.titlePg) {
        titlePg = true;
        if (headers && sp.headerReferences) {
          const firstRef = sp.headerReferences.find((r) => r.type === "first");
          if (firstRef?.rId) {
            firstHeader = headers.get(firstRef.rId) ?? null;
            resolvedFirstHeaderRId = firstRef.rId;
          }
        }
        if (footers && sp.footerReferences) {
          const firstRef = sp.footerReferences.find((r) => r.type === "first");
          if (firstRef?.rId) {
            firstFooter = footers.get(firstRef.rId) ?? null;
            resolvedFirstFooterRId = firstRef.rId;
          }
        }
        break; // first section with titlePg wins
      }
    }

    // Fallback: if no section has titlePg, check finalSectionProperties for
    // first-page refs (they won't be used as first-page without titlePg,
    // but keep them so the "only first headers exist" fallback below works)
    if (!titlePg && headers) {
      const refs = finalProps?.headerReferences;
      const firstRef = refs?.find((r) => r.type === "first");
      if (firstRef?.rId) {
        firstHeader = headers.get(firstRef.rId) ?? null;
        resolvedFirstHeaderRId = firstRef.rId;
      }
    }
    if (!titlePg && footers) {
      const refs = finalProps?.footerReferences;
      const firstRef = refs?.find((r) => r.type === "first");
      if (firstRef?.rId) {
        firstFooter = footers.get(firstRef.rId) ?? null;
        resolvedFirstFooterRId = firstRef.rId;
      }
    }

    // When titlePg is not set but only 'first' headers exist, use them as default.
    // Mirror the rId fallback so save/remove targets the rId actually
    // rendered — otherwise the active default rId stays null and edits to
    // the displayed header/footer silently no-op (Codex PR #258 review).
    if (!titlePg) {
      if (!header && firstHeader) {
        header = firstHeader;
        resolvedHeaderRId = resolvedFirstHeaderRId;
      }
      if (!footer && firstFooter) {
        footer = firstFooter;
        resolvedFooterRId = resolvedFirstFooterRId;
      }
    }

    return {
      headerContent: header,
      footerContent: footer,
      firstPageHeaderContent: firstHeader,
      firstPageFooterContent: firstFooter,
      hasTitlePg: titlePg,
      // Active rIds for the *displayed* H/F. Save/remove must target
      // these — not finalSectionProperties — otherwise edits to a
      // multi-section doc's title-page footer end up in the
      // (hidden) final section's rId and the visible footer never
      // updates (Codex PR #258 review).
      activeHeaderRId: resolvedHeaderRId,
      activeFooterRId: resolvedFooterRId,
      activeFirstHeaderRId: resolvedFirstHeaderRId,
      activeFirstFooterRId: resolvedFirstFooterRId,
    };
  }, [history.state]);

  // -------------------------------------------------------------------------
  // Effective section properties (titlePg merged)
  // -------------------------------------------------------------------------

  const effectiveSectionProperties = useMemo(
    () =>
      resolveEffectiveSectionProperties(
        history.state?.package.document,
        hasTitlePg,
      ),
    [history.state?.package.document, hasTitlePg],
  );

  // -------------------------------------------------------------------------
  // Callbacks
  // -------------------------------------------------------------------------

  const handleHeaderFooterDoubleClick = useCallback(
    (position: "header" | "footer", pageNumber?: number) => {
      const isFirstPage = hasTitlePg && (pageNumber ?? 1) === 1;
      let hf = position === "header" ? headerContent : footerContent;
      if (isFirstPage) {
        hf =
          position === "header"
            ? firstPageHeaderContent
            : firstPageFooterContent;
      }
      setHfEditIsFirstPage(isFirstPage);
      if (hf) {
        setHfEditPosition(position);
        return;
      }

      // Create empty header/footer for docs that don't have one yet
      if (!history.state?.package) {
        return;
      }
      const pkg = history.state.package;
      const sectionProps = pkg.document.finalSectionProperties;
      if (!sectionProps) {
        return;
      }

      const hdrFtrType = isFirstPage ? "first" : "default";
      const rId = `rId_new_${position}_${hdrFtrType}`;
      const emptyHf: HeaderFooter = {
        type: position === "header" ? "header" : "footer",
        hdrFtrType,
        content: [{ type: "paragraph", content: [] }],
      };

      const mapKey = position === "header" ? "headers" : "footers";
      const newMap = new Map(pkg[mapKey]);
      newMap.set(rId, emptyHf);

      const refKey =
        position === "header" ? "headerReferences" : "footerReferences";
      const existingRefs = sectionProps[refKey] ?? [];
      const newRef = {
        type: hdrFtrType as "default" | "first",
        rId,
      };

      const newDoc: Document = {
        ...history.state,
        package: {
          ...pkg,
          [mapKey]: newMap,
          document: {
            ...pkg.document,
            finalSectionProperties: {
              ...sectionProps,
              [refKey]: [...existingRefs, newRef],
            },
          },
        },
      };
      pushDocument(newDoc);
      setHfEditPosition(position);
    },
    [
      headerContent,
      footerContent,
      firstPageHeaderContent,
      firstPageFooterContent,
      hasTitlePg,
      history,
      pushDocument,
    ],
  );

  const handleHeaderFooterSave = useCallback(() => {
    if (!hfEditPosition || !history.state?.package) {
      setHfEditPosition(null);
      return;
    }

    const pkg = history.state.package;
    // Save into the rId resolved by the SAME algorithm that picks the
    // displayed H/F (see the resolver useMemo above) — for multi-section
    // docs (NVCA-style title-page + signature sections) this is the
    // rendered rId, not finalSectionProperties' rId. Codex PR #258 review.
    let activeRId =
      hfEditPosition === "header" ? activeHeaderRId : activeFooterRId;
    if (hfEditIsFirstPage) {
      activeRId =
        hfEditPosition === "header"
          ? activeFirstHeaderRId
          : activeFirstFooterRId;
    }
    const refType = hfEditIsFirstPage ? "first" : "default";
    const mapKey = hfEditPosition === "header" ? "headers" : "footers";
    const map = pkg[mapKey];

    if (activeRId && map) {
      const existing = map.get(activeRId);
      const view = getHfView(activeRId);
      if (existing && view) {
        // Read fresh blocks from PM state — HiddenHeaderFooterPMs no
        // longer mutates `existing.content` in place (Codex #487 P1
        // re-fixed), so `existing` here still holds the pre-edit
        // snapshot. We construct a brand-new HeaderFooter inside a
        // brand-new Map so the previous Document referenced by every
        // earlier history entry stays untouched and undo can step
        // back to the pre-edit state.
        const blocks: BlockContent[] = proseDocToBlocks(view.state.doc);
        const updated: HeaderFooter = {
          ...existing,
          type: hfEditPosition,
          hdrFtrType: refType,
          content: blocks,
        };
        const newMap = new Map(map);
        newMap.set(activeRId, updated);

        const newDoc: Document = {
          ...history.state,
          package: {
            ...pkg,
            [mapKey]: newMap,
          },
        };
        pushDocument(newDoc);
      }
    }

    setHfEditPosition(null);
  }, [
    hfEditPosition,
    hfEditIsFirstPage,
    activeHeaderRId,
    activeFooterRId,
    activeFirstHeaderRId,
    activeFirstFooterRId,
    history,
    pushDocument,
    getHfView,
  ]);

  const handleBodyClick = useCallback(() => {
    if (!hfEditPosition) {
      return;
    }
    // HF content is kept current by the HF PM's in-place sync
    // (HiddenHeaderFooterPMs.dispatchTransaction); the close path just
    // needs to publish the current state as a history snapshot.
    handleHeaderFooterSave();
  }, [hfEditPosition, handleHeaderFooterSave]);

  const handleRemoveHeaderFooter = useCallback(() => {
    if (!hfEditPosition || !history.state?.package) {
      setHfEditPosition(null);
      return;
    }

    const pkg = history.state.package;
    const refKey =
      hfEditPosition === "header" ? "headerReferences" : "footerReferences";
    const mapKey = hfEditPosition === "header" ? "headers" : "footers";

    // Same active-rId resolution as save: target the rId actually
    // rendered, not whatever lives in `finalSectionProperties` (Codex
    // PR #258 review). Drop the ref from every section that points at
    // this rId so we don't leave a dangling reference behind.
    let activeRId =
      hfEditPosition === "header" ? activeHeaderRId : activeFooterRId;
    if (hfEditIsFirstPage) {
      activeRId =
        hfEditPosition === "header"
          ? activeFirstHeaderRId
          : activeFirstFooterRId;
    }

    if (activeRId) {
      const newMap = new Map(pkg[mapKey]);
      newMap.delete(activeRId);

      const stripRef = (sp: SectionProperties): SectionProperties => {
        const refs = sp[refKey];
        if (!refs?.some((r) => r.rId === activeRId)) {
          return sp;
        }
        return {
          ...sp,
          [refKey]: refs.filter((r) => r.rId !== activeRId),
        };
      };

      const oldDoc = pkg.document;
      const newSections = oldDoc.sections?.map((s) => ({
        ...s,
        properties: stripRef(s.properties),
      }));
      const newFinalProps = oldDoc.finalSectionProperties
        ? stripRef(oldDoc.finalSectionProperties)
        : oldDoc.finalSectionProperties;

      const newDoc: Document = {
        ...history.state,
        package: {
          ...pkg,
          [mapKey]: newMap,
          document: {
            ...oldDoc,
            ...(newSections !== undefined ? { sections: newSections } : {}),
            ...(newFinalProps !== undefined
              ? { finalSectionProperties: newFinalProps }
              : {}),
          },
        },
      };
      pushDocument(newDoc);
    }

    setHfEditPosition(null);
  }, [
    hfEditPosition,
    hfEditIsFirstPage,
    activeHeaderRId,
    activeFooterRId,
    activeFirstHeaderRId,
    activeFirstFooterRId,
    history,
    pushDocument,
  ]);

  return {
    hfEditPosition,
    setHfEditPosition,
    hfEditIsFirstPage,
    headerContent,
    footerContent,
    firstPageHeaderContent,
    firstPageFooterContent,
    hasTitlePg,
    activeHeaderRId,
    activeFooterRId,
    activeFirstHeaderRId,
    activeFirstFooterRId,
    effectiveSectionProperties,
    handleHeaderFooterDoubleClick,
    handleHeaderFooterSave,
    handleBodyClick,
    handleRemoveHeaderFooter,
  };
};
