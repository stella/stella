import { panic } from "better-result";

import type { ChatSourceCitationTarget } from "@stll/api-contract";

type SourceCitationNavigationDeps = {
  dispatchBlockScroll: (request: {
    blockId: string;
    fieldId: string;
    text?: string | undefined;
  }) => void;
  openSource: (
    target: ChatSourceCitationTarget,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  requestBlockScroll: (request: {
    tabId: string;
    blockId: string;
    text?: string | undefined;
  }) => void;
  requestPdfPageScroll: (request: {
    tabId: string;
    pageNumber: number;
  }) => void;
};

let latestSourceCitationActivation = 0;

const beginSourceCitationActivation = (): (() => boolean) => {
  latestSourceCitationActivation += 1;
  const activation = latestSourceCitationActivation;
  return () => activation === latestSourceCitationActivation;
};

/** Open a verified source before delivering its locator to the exact viewer.
 * Keeping the source identity on both branches prevents a DOCX block or PDF
 * page number from being applied to whichever document happened to be active. */
export const activateSourceCitation = async ({
  deps,
  target,
}: {
  deps: SourceCitationNavigationDeps;
  target: ChatSourceCitationTarget;
}): Promise<void> => {
  const isCurrent = beginSourceCitationActivation();
  if (!(await deps.openSource(target, isCurrent)) || !isCurrent()) {
    return;
  }

  switch (target.type) {
    case "docx-folio":
      deps.requestBlockScroll({
        tabId: target.fieldId,
        blockId: target.blockId,
        text: target.text,
      });
      deps.dispatchBlockScroll({
        fieldId: target.fieldId,
        blockId: target.blockId,
        text: target.text,
      });
      break;
    case "pdf-bates":
      deps.requestPdfPageScroll({
        tabId: target.fieldId,
        pageNumber: target.pageNumber,
      });
      break;
    default:
      target satisfies never;
      panic(`Unhandled target: ${String(target)}`);
  }
};
