/**
 * Hook encapsulating header/footer editing state, content resolution, and
 * mutation callbacks extracted from DocxEditor.
 */

import { useState, useMemo, useCallback } from "react";
import type { RefObject } from "react";

import { proseDocToBlocks } from "../../core/prosemirror/conversion/fromProseDoc";
import type {
  Document,
  DocumentBody,
  HeaderFooter,
  SectionProperties,
  Paragraph,
  Table,
} from "../../core/types/document";
import type { UseHistoryReturn } from "../../hooks/useHistory";
import type { InlineHeaderFooterEditorRef } from "../InlineHeaderFooterEditor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UseHeaderFooterEditorParams = {
  history: UseHistoryReturn<Document | null>;
  pushDocument: (document: Document) => Document;
  hfEditorRef: RefObject<InlineHeaderFooterEditorRef | null>;
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

  /** Section properties with titlePg merged from inline sections */
  effectiveSectionProperties: SectionProperties | undefined;

  /** Open the inline HF editor on double-click; creates an empty HF if needed */
  handleHeaderFooterDoubleClick: (
    position: "header" | "footer",
    pageNumber?: number,
  ) => void;
  /** Persist edited blocks back into the document package */
  handleHeaderFooterSave: (content: (Paragraph | Table)[]) => void;
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
  hfEditorRef,
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
  } = useMemo<{
    headerContent: HeaderFooter | null;
    footerContent: HeaderFooter | null;
    firstPageHeaderContent: HeaderFooter | null;
    firstPageFooterContent: HeaderFooter | null;
    hasTitlePg: boolean;
  }>(() => {
    if (!history.state?.package) {
      return {
        headerContent: null,
        footerContent: null,
        firstPageHeaderContent: null,
        firstPageFooterContent: null,
        hasTitlePg: false,
      };
    }

    const pkg = history.state.package;
    const finalProps = pkg.document?.finalSectionProperties;
    const sections = pkg.document?.sections;
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
    if (headers) {
      for (const sp of allSectionProps) {
        if (!sp.headerReferences) {
          continue;
        }
        const defaultRef = sp.headerReferences.find(
          (r) => r.type === "default",
        );
        if (defaultRef?.rId) {
          header = headers.get(defaultRef.rId) ?? header;
        }
      }
    }

    if (footers) {
      for (const sp of allSectionProps) {
        if (!sp.footerReferences) {
          continue;
        }
        const defaultRef = sp.footerReferences.find(
          (r) => r.type === "default",
        );
        if (defaultRef?.rId) {
          footer = footers.get(defaultRef.rId) ?? footer;
        }
      }
    }

    // Resolve first-page headers/footers: find the first section with titlePg
    for (const sp of allSectionProps) {
      if (sp.titlePg) {
        titlePg = true;
        if (headers && sp.headerReferences) {
          const firstRef = sp.headerReferences.find((r) => r.type === "first");
          if (firstRef?.rId) {
            firstHeader = headers.get(firstRef.rId) ?? null;
          }
        }
        if (footers && sp.footerReferences) {
          const firstRef = sp.footerReferences.find((r) => r.type === "first");
          if (firstRef?.rId) {
            firstFooter = footers.get(firstRef.rId) ?? null;
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
      }
    }
    if (!titlePg && footers) {
      const refs = finalProps?.footerReferences;
      const firstRef = refs?.find((r) => r.type === "first");
      if (firstRef?.rId) {
        firstFooter = footers.get(firstRef.rId) ?? null;
      }
    }

    // When titlePg is not set but only 'first' headers exist, use them as default
    if (!titlePg) {
      if (!header && firstHeader) {
        header = firstHeader;
      }
      if (!footer && firstFooter) {
        footer = firstFooter;
      }
    }

    return {
      headerContent: header,
      footerContent: footer,
      firstPageHeaderContent: firstHeader,
      firstPageFooterContent: firstFooter,
      hasTitlePg: titlePg,
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
      const hf = isFirstPage
        ? position === "header"
          ? firstPageHeaderContent
          : firstPageFooterContent
        : position === "header"
          ? headerContent
          : footerContent;
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
      const sectionProps = pkg.document?.finalSectionProperties;
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
          document: pkg.document
            ? {
                ...pkg.document,
                finalSectionProperties: {
                  ...sectionProps,
                  [refKey]: [...existingRefs, newRef],
                },
              }
            : pkg.document,
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

  const handleHeaderFooterSave = useCallback(
    (content: (Paragraph | Table)[]) => {
      if (!hfEditPosition || !history.state?.package) {
        setHfEditPosition(null);
        return;
      }

      const pkg = history.state.package;
      const sectionProps = pkg.document?.finalSectionProperties;
      const refs =
        hfEditPosition === "header"
          ? sectionProps?.headerReferences
          : sectionProps?.footerReferences;
      const targetType = hfEditIsFirstPage ? "first" : "default";
      const activeRef =
        refs?.find((r) => r.type === targetType) ??
        refs?.find((r) => r.type === "default") ??
        refs?.find((r) => r.type === "first") ??
        refs?.[0];
      const mapKey = hfEditPosition === "header" ? "headers" : "footers";
      const map = pkg[mapKey];

      if (activeRef?.rId && map) {
        const existing = map.get(activeRef.rId);
        const updated: HeaderFooter = {
          type: hfEditPosition,
          hdrFtrType: activeRef.type as "default" | "first" | "even",
          ...existing,
          content,
        };
        const newMap = new Map(map);
        newMap.set(activeRef.rId, updated);

        const newDoc: Document = {
          ...history.state,
          package: {
            ...pkg,
            [mapKey]: newMap,
          },
        };
        pushDocument(newDoc);
      }

      setHfEditPosition(null);
    },
    [hfEditPosition, hfEditIsFirstPage, history, pushDocument],
  );

  const handleBodyClick = useCallback(() => {
    if (!hfEditPosition) {
      return;
    }
    // Save if dirty, then close
    const view = hfEditorRef.current?.getView();
    if (view) {
      const blocks = proseDocToBlocks(view.state.doc);
      handleHeaderFooterSave(blocks);
    } else {
      setHfEditPosition(null);
    }
  }, [hfEditPosition, hfEditorRef, handleHeaderFooterSave]);

  const handleRemoveHeaderFooter = useCallback(() => {
    if (!hfEditPosition || !history.state?.package) {
      setHfEditPosition(null);
      return;
    }

    const pkg = history.state.package;
    const sectionProps = pkg.document?.finalSectionProperties;
    const refKey =
      hfEditPosition === "header" ? "headerReferences" : "footerReferences";
    const mapKey = hfEditPosition === "header" ? "headers" : "footers";
    const refs = sectionProps?.[refKey];
    const delTargetType = hfEditIsFirstPage ? "first" : "default";
    const activeRef =
      refs?.find((r) => r.type === delTargetType) ??
      refs?.find((r) => r.type === "default") ??
      refs?.find((r) => r.type === "first") ??
      refs?.[0];

    if (activeRef?.rId) {
      const newMap = new Map(pkg[mapKey]);
      newMap.delete(activeRef.rId);

      const newRefs = (refs ?? []).filter((r) => r.rId !== activeRef.rId);

      const newDoc: Document = {
        ...history.state,
        package: {
          ...pkg,
          [mapKey]: newMap,
          document: pkg.document
            ? {
                ...pkg.document,
                finalSectionProperties: {
                  ...sectionProps,
                  [refKey]: newRefs,
                },
              }
            : pkg.document,
        },
      };
      pushDocument(newDoc);
    }

    setHfEditPosition(null);
  }, [hfEditPosition, hfEditIsFirstPage, history, pushDocument]);

  return {
    hfEditPosition,
    setHfEditPosition,
    hfEditIsFirstPage,
    headerContent,
    footerContent,
    firstPageHeaderContent,
    firstPageFooterContent,
    hasTitlePg,
    effectiveSectionProperties,
    handleHeaderFooterDoubleClick,
    handleHeaderFooterSave,
    handleBodyClick,
    handleRemoveHeaderFooter,
  };
};
