import type { ReactNode } from "react";

import { BidiText } from "@stll/ui/bidi-text";

import { useReaderMessages } from "./reader-adapters";
import type { UnresolvedCitationAnchorSource } from "./reader-types";
import { ReferencePeek } from "./reference-peek";

/** Marked, not linked: there is nowhere in stella to follow it to. */
const UNRESOLVED_CITATION_CLASS_NAME =
  "decoration-foreground-placeholder hover:decoration-foreground-muted data-[popup-open]:decoration-foreground-muted rounded-xs underline decoration-dotted underline-offset-2 transition-[text-decoration-color] duration-150 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none";

/**
 * A citation of a decision stella does not hold. The text stays as the court
 * wrote it, marked so the reader can peek at what it names and learn that
 * there is no decision to open yet.
 */
export const UnresolvedCitation = ({
  children,
  citation,
}: {
  children: ReactNode;
  citation: UnresolvedCitationAnchorSource;
}) => {
  const messages = useReaderMessages();
  return (
    <ReferencePeek
      body={
        <BidiText as="span" className="text-muted-foreground text-xs">
          {messages["caseLaw.citation.notInStella"]}
        </BidiText>
      }
      header={{ primary: citation.citationText, meta: [] }}
      target={{ kind: "unresolvedCitation", actions: {} }}
      trigger={{
        type: "text",
        element: (
          <span
            className={UNRESOLVED_CITATION_CLASS_NAME}
            data-unresolved-citation={citation.id}
          />
        ),
      }}
    >
      {children}
    </ReferencePeek>
  );
};
