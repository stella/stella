import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PropsWithChildren } from "react";

import DOMPurify from "dompurify";
import parse, { domToReact, Element } from "html-react-parser";
import type { DOMNode } from "html-react-parser";

import { cn } from "@stella/ui/lib/utils";

import { usePDFStore } from "@/lib/pdf/pdf-context";
import type { WorkspaceJustification } from "@/lib/types";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

type PeekJustificationProps = {
  justification: WorkspaceJustification;
  activeFileFieldId: string;
};

/** Renders AI justification text with clickable citations
 *  that scroll the peek PDF viewer to the cited page. */
export const PeekJustification = ({
  justification,
  activeFileFieldId,
}: PeekJustificationProps) => {
  const setActiveJustification = useWorkspaceStore(
    (s) => s.setActiveJustification,
  );
  const pages = usePDFStore((s) => s.pages);
  const setScrollTo = usePDFStore((s) => s.setScrollTo);

  // Keep a ref so the effect and click handler can read the
  // latest pages without depending on the Map reference (which
  // changes on every viewport recalculation and would cause an
  // infinite effect loop).
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  const handleCitationClick = useCallback(
    (_fieldId: string, pageNumber: number) => {
      setActiveJustification({
        id: justification.id,
        pageNumber,
      });
      const pageIds = [...pagesRef.current.keys()];
      const pageId = pageIds[pageNumber - 1];
      if (pageId !== undefined) {
        setScrollTo({
          pageId,
          target: { kind: "justification", id: justification.id },
        });
      }
    },
    [justification.id, setActiveJustification, setScrollTo],
  );

  // Parse once so we can extract the first cited page
  const { parsed: nodes, firstPage } = useMemo(() => {
    const safeHtml = DOMPurify.sanitize(justification.htmlContent, {
      ALLOWED_TAGS: ["span", "strong", "em", "b", "i", "u", "p", "br", "cite"],
      ALLOWED_ATTR: ["data-page-number", "data-field-id"],
    });
    let fp: number | null = null;

    const result = parse(safeHtml, {
      replace: (node) => {
        if (!(node instanceof Element)) {
          return node;
        }

        const pageNumberAttr = node.attribs["data-page-number"];
        const fileFieldId = node.attribs["data-field-id"];

        if (!pageNumberAttr || !fileFieldId) {
          return node;
        }

        const pageNumber = +pageNumberAttr;

        if (Number.isNaN(pageNumber)) {
          return node;
        }

        fp ??= pageNumber;

        const isSameFile = fileFieldId === activeFileFieldId;

        return (
          <PeekCitation
            disabled={!isSameFile}
            onClick={() => handleCitationClick(fileFieldId, pageNumber)}
          >
            {/* SAFETY: html-react-parser's Element.children is
                typed as ChildNode[] which is structurally
                compatible with DOMNode[] */}
            {/* eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion */}
            {domToReact(node.children as DOMNode[])}
          </PeekCitation>
        );
      },
    });

    return { parsed: result, firstPage: fp };
  }, [justification.htmlContent, activeFileFieldId, handleCitationClick]);

  // Activate the justification and scroll to the first cited page
  // when expanded. Bbox generation is handled by JustificationBar.
  useEffect(() => {
    if (firstPage !== null) {
      setActiveJustification({
        id: justification.id,
        pageNumber: firstPage,
      });
      const pageIds = [...pagesRef.current.keys()];
      const pageId = pageIds[firstPage - 1];
      if (pageId !== undefined) {
        setScrollTo({
          pageId,
          target: { kind: "justification", id: justification.id },
        });
      }
    }
  }, [justification.id, firstPage, setActiveJustification, setScrollTo]);

  // Clear active justification on unmount.
  useEffect(() => () => setActiveJustification(null), [setActiveJustification]);

  return <div>{nodes}</div>;
};

type PeekCitationProps = {
  disabled: boolean;
  onClick: () => void;
};

const PeekCitation = ({
  children,
  onClick,
  disabled,
}: PropsWithChildren<PeekCitationProps>) => (
  <button
    className={cn(
      "bg-muted hover:bg-accent inline-block rounded px-1.5 py-0.5 text-xs font-medium transition-colors",
      disabled && "opacity-50",
    )}
    disabled={disabled}
    onClick={onClick}
    type="button"
  >
    {children}
  </button>
);
