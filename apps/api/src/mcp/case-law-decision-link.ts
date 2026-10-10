import { Result } from "better-result";

import {
  decisionParagraphFragment,
  parseDecisionParagraphRange,
} from "@stll/api-contract/decision-paragraph-range";

type DecisionDeepLinkOptions = {
  appUrl: string | null;
  anchorId: string | null;
  number?: number | undefined;
};

/** The reader's address for one block: the decision's page and its fragment. */
export const decisionBlockDeepLink = ({
  appUrl,
  anchorId,
  number,
}: DecisionDeepLinkOptions) => {
  if (appUrl === null) {
    return {};
  }
  if (number !== undefined) {
    const range = parseDecisionParagraphRange(String(number));
    if (Result.isOk(range)) {
      return { url: `${appUrl}#${decisionParagraphFragment(range.value)}` };
    }
  }
  // The web router decodes fragments with decodeURI, preserving escaped reserved characters.
  return anchorId === null ? {} : { url: `${appUrl}#${encodeURI(anchorId)}` };
};
