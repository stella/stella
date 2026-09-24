import { panic } from "better-result";

import {
  DECISION_READ_RESOLUTION,
  type DecisionReadResolution,
} from "@stll/api-contract/case-law-decision-resolution";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";

type AnchorAfterResolutionOptions = {
  resolution: DecisionReadResolution;
  /** The returned decision's document, as the read sent it. */
  documentAst: unknown;
  /** The block the address named, without a `#`. */
  anchorId: string | undefined;
};

/**
 * The block to open the returned decision at.
 *
 * An address naming reasons absorbed into their judgment lands on the
 * reasons inside it: the block it named, under the prefix the reasons' blocks
 * carry there, or the reasons' first block when that block is not there. A
 * judgment whose document has no blocks (text only) has no such anchor, so
 * none is named rather than one the reader cannot find.
 */
export const anchorAfterResolution = ({
  resolution,
  documentAst,
  anchorId,
}: AnchorAfterResolutionOptions): string | undefined => {
  switch (resolution.type) {
    case DECISION_READ_RESOLUTION.DIRECT:
      return anchorId;
    case DECISION_READ_RESOLUTION.ABSORBED_SUPPLEMENT: {
      const blocks = parseDocumentAst(documentAst)?.blocks;
      if (blocks === undefined) {
        return undefined;
      }
      const inReasons = blocks
        .map((block) => block.anchorId)
        .filter((anchor) => anchor.startsWith(resolution.anchorPrefix));
      const named =
        anchorId === undefined
          ? undefined
          : `${resolution.anchorPrefix}${anchorId}`;
      return named !== undefined && inReasons.includes(named)
        ? named
        : inReasons.at(0);
    }
    default: {
      resolution satisfies never;
      return panic(`Unhandled decision resolution: ${String(resolution)}`);
    }
  }
};
