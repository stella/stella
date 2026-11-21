import { Result } from "better-result";

import {
  decisionParagraphFragment,
  parseDecisionParagraphRange,
} from "@stll/api-contract/decision-paragraph-range";

type DecisionDeepLinkOptions = {
  url: string | null;
  anchorId: string | null;
  number?: number | undefined;
};

/** The reader's address for one block: the decision's page and its fragment. */
export const decisionBlockDeepLink = ({
  url,
  anchorId,
  number,
}: DecisionDeepLinkOptions) => {
  if (url === null) {
    return {};
  }
  if (number !== undefined) {
    const range = parseDecisionParagraphRange(String(number));
    if (Result.isOk(range)) {
      return { url: `${url}#${decisionParagraphFragment(range.value)}` };
    }
  }
  // The web router decodes fragments with decodeURI, preserving escaped reserved characters.
  return anchorId === null ? {} : { url: `${url}#${encodeURI(anchorId)}` };
};
