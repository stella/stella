import type { ReactNode } from "react";

import type { DecisionBodySource } from "@stll/api-contract/case-law-body-source";
import { BidiText } from "@stll/ui/bidi-text";

import { useReaderMessages } from "./reader-adapters";
import { sanitizeHref } from "./sanitize-href";

export type CollectionBodySource = Extract<
  DecisionBodySource,
  { textSource: "collection" }
>;

/** The strings a host supplies for a collection body's attribution. */
export type CollectionAttributionMessages = {
  partialText: string;
  unclassifiedText: string;
  sourceAttribution: (
    source: string,
    date: string | null,
    link: (children: ReactNode) => ReactNode,
  ) => ReactNode;
  provenanceOmitted: (counts: {
    omittedCount: number;
    totalCount: number;
  }) => string;
};

/** Every publication a collection body was composed from, with its link and date. */
export const CollectionAttributionList = ({
  bodySource,
  messages,
}: {
  bodySource: CollectionBodySource;
  messages: CollectionAttributionMessages;
}) => {
  const { formatValidityDate } = useReaderMessages();
  const extentText = {
    complete: null,
    section: messages.partialText,
    unclassified: messages.unclassifiedText,
  }[bodySource.extent];
  return (
    <>
      {extentText === null ? null : <p>{extentText}</p>}
      <ul className="list-none space-y-1">
        {bodySource.provenance.records.map((publication) => {
          const href = sanitizeHref(publication.sourceUrl);
          const label =
            publication.sourceDocumentId === null
              ? publication.source.name
              : `${publication.source.name} (${publication.sourceDocumentId})`;
          const date =
            publication.retrievedAt === null
              ? null
              : (formatValidityDate(publication.retrievedAt) ??
                publication.retrievedAt);
          return (
            <li
              key={JSON.stringify([
                publication.source.id,
                publication.sourceDocumentId,
                publication.sourceUrl,
              ])}
            >
              {messages.sourceAttribution(label, date, (chunks) =>
                href === undefined ? (
                  <BidiText>{chunks}</BidiText>
                ) : (
                  <a
                    className="hover:text-foreground underline underline-offset-2"
                    href={href}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    <BidiText>{chunks}</BidiText>
                  </a>
                ),
              )}
            </li>
          );
        })}
      </ul>
      {bodySource.provenance.coverage === "truncated" ? (
        <p>{messages.provenanceOmitted(bodySource.provenance)}</p>
      ) : null}
    </>
  );
};
