import { Fragment } from "react";
import type { ReactNode } from "react";

import type { JustificationContent } from "@/lib/types";

type RenderCitationArgs = {
  children: ReactNode;
  fileFieldId: string;
  key: string;
  pageNumber: number;
};

type RenderJustificationContentResult = {
  firstPage: number | null;
  nodes: ReactNode[];
};

type RenderJustificationContentOptions = {
  content: JustificationContent;
  firstPageFileFieldId?: string;
  renderCitation: (args: RenderCitationArgs) => ReactNode;
};

export const renderJustificationContent = ({
  content,
  firstPageFileFieldId,
  renderCitation,
}: RenderJustificationContentOptions): RenderJustificationContentResult => {
  const nodes: ReactNode[] = [];
  let firstPage: number | null = null;

  for (const [blockIndex, block] of content.blocks.entries()) {
    for (const [statementIndex, statement] of block.statements.entries()) {
      const statementKey = `${blockIndex}-${statementIndex}`;
      nodes.push(
        <Fragment key={`${statementKey}-text`}>{statement.text} </Fragment>,
      );

      for (const [citationIndex, citation] of statement.citations.entries()) {
        const isFirstPageCandidate =
          firstPageFileFieldId === undefined ||
          firstPageFileFieldId === block.fileFieldId;

        if (isFirstPageCandidate) {
          firstPage ??= citation.pageNumber;
        }

        const key = `${statementKey}-${citationIndex}`;
        nodes.push(
          renderCitation({
            children: citation.pageNumber,
            fileFieldId: block.fileFieldId,
            key,
            pageNumber: citation.pageNumber,
          }),
          <Fragment key={`${key}-space`}> </Fragment>,
        );
      }
    }
  }

  return { firstPage, nodes };
};
