import { panic } from "better-result";

import type { ReaderAnnotationTargetType } from "@stll/api-contract/legal-reader-annotations";

import { activeLegalFromReaderTarget } from "@/components/ai-suggestions/active-legal-document";
import {
  decisionPassageContent,
  writeDecisionPassage,
} from "@/components/chat-decision-passage";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { SelectionAnchor } from "@/components/legal-reader/annotations/selection-anchor";
import { openPublicLawChat } from "@/components/public-law-ask";
import { formatDecisionCitation } from "@/features/case-law/citation-format";
import { decisionChatKey } from "@/features/chat/legal-document-chat-key";
import { ensureLegalDocumentChatThread } from "@/features/chat/legal-document-chat-threads";
import { formatStatuteCitation } from "@/features/statutes/statute-format";
import {
  createChatDraftState,
  useChatDraftStore,
} from "@/lib/chat-draft-store";
import { getChatThreadKey } from "@/lib/chat-thread-ref";

/**
 * The document a reader is marking, in the terms a citation and a chat
 * reference need. Everything else about the highlighter is the same on both
 * corpora, so this union is the whole of what differs.
 */
export type ReaderAnnotationTarget =
  | {
      type: "decision";
      caseNumber: string;
      country: string;
      court: string;
      decisionDate: string | null;
      decisionType: string | null;
      ecli: string | null;
      id: string;
      /** Citable case name ("Brown v. Board of Education"); null when the
       * document does not state one. */
      name: string | null;
    }
  | {
      type: "statute";
      /** The consolidation on screen: its id already names the version, so
       * an anchor can only ever mean the wording it was placed on. */
      id: string;
      country: string;
      eli: string;
      /** The provision each block sits under, so a citation carries a
       * locator rather than pointing at the whole act. */
      provisionByAnchorId: ReadonlyMap<string, string>;
      title: string;
      versionValidFrom: string | null;
    };

/** How the annotation store and the API address the document. */
export const readerAnnotationTargetKey = (
  target: ReaderAnnotationTarget,
): { targetId: string; targetType: ReaderAnnotationTargetType } => ({
  targetId: target.id,
  targetType: target.type,
});

/**
 * What a citation points at inside the document, from the marked paragraphs
 * alone: the provision a statute passage sits in. A decision's locator is its
 * reporter page, which only the live selection can say, so a passage read back
 * from stored spans carries none.
 */
export const readerSpansLocator = ({
  spans,
  target,
}: {
  spans: readonly { blockAnchorId: string }[];
  target: ReaderAnnotationTarget;
}): string | null => {
  switch (target.type) {
    case "decision": {
      return null;
    }
    case "statute": {
      const blockAnchorId = spans.at(0)?.blockAnchorId;
      return blockAnchorId === undefined
        ? null
        : (target.provisionByAnchorId.get(blockAnchorId) ?? null);
    }
    default: {
      target satisfies never;
      return panic(`Unhandled reader target: ${String(target)}`);
    }
  }
};

/**
 * What a citation points at inside the document: the reporter page a
 * quotation starts on for a decision, the provision it sits in for a statute.
 * Null where the document offers neither.
 */
export const readerSelectionLocator = ({
  range,
  root,
  spans,
  target,
}: {
  range: Range;
  root: HTMLElement;
  spans: readonly SelectionAnchor[];
  target: ReaderAnnotationTarget;
}): string | null => {
  if (target.type !== "decision") {
    return readerSpansLocator({ spans, target });
  }
  let last: string | null = null;
  for (const marker of root.querySelectorAll(".reader-page-marker")) {
    // -1: the marker sits before the selection's start.
    if (range.comparePoint(marker, 0) !== -1) {
      continue;
    }
    const digits = /\d+/u.exec(marker.textContent)?.[0];
    if (digits !== undefined) {
      last = digits;
    }
  }
  return last;
};

/** The citation a copied quotation carries. */
export const readerTargetCitation = ({
  locator,
  target,
}: {
  locator: string | null;
  target: ReaderAnnotationTarget;
}): string => {
  switch (target.type) {
    case "decision": {
      return formatDecisionCitation({
        caseNumber: target.caseNumber,
        country: target.country,
        court: target.court,
        decisionDate: target.decisionDate,
        decisionType: target.decisionType,
        ecli: target.ecli,
        name: target.name,
        pincite: locator,
      });
    }
    case "statute": {
      return formatStatuteCitation({
        eli: target.eli,
        provision: locator,
        title: target.title,
        versionValidFrom: target.versionValidFrom,
      });
    }
    default: {
      target satisfies never;
      return panic(`Unhandled reader target: ${String(target)}`);
    }
  }
};

/**
 * Opens the document's inspector chat on the selected passage. A decision is a
 * resource the corpus tools can be handed, so the passage lands as chips with
 * the decision attached; a consolidation has no reference chip, so the prompt
 * names it in words. Either way the question joins the conversation the
 * reader's floating composer is already bound to.
 */
export const askAboutReaderPassage = ({
  prompt,
  quote,
  target,
}: {
  /** The question as prose, for a target the chat has no reference chip for. */
  prompt: string;
  quote: string;
  target: ReaderAnnotationTarget;
}): void => {
  switch (target.type) {
    case "decision": {
      // The decision has one conversation, so the passage joins it instead of
      // opening a rival thread beside it. The draft this writes replaces
      // whatever was unsent in that composer: losing a half-typed line is the
      // lesser harm against asking the question away from the history it
      // belongs to.
      const documentKey = decisionChatKey(target.id);
      const threadId = ensureLegalDocumentChatThread({ documentKey });
      useChatDraftStore.getState().setDraft(
        getChatThreadKey({ scope: "global", threadId }),
        createChatDraftState({
          doc: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: decisionPassageContent({
                  caseNumber: target.caseNumber,
                  court: target.court,
                  decisionId: target.id,
                  quote,
                }),
              },
            ],
          },
        }),
      );
      useInspectorTabsStore.getState().openChat({
        activeLegalKey: documentKey,
        id: threadId,
        label: target.caseNumber,
      });
      return;
    }
    case "statute": {
      openPublicLawChat({
        document: activeLegalFromReaderTarget(target),
        label: target.title,
        prompt,
      });
      return;
    }
    default: {
      target satisfies never;
      return panic(`Unhandled reader target: ${String(target)}`);
    }
  }
};

/**
 * What dragging selected words carries. A decision passage drops on the chat
 * composer as chips; a statute has no reference chip, so it carries its words.
 */
export const writeReaderPassage = ({
  dataTransfer,
  quote,
  target,
}: {
  dataTransfer: DataTransfer;
  quote: string;
  target: ReaderAnnotationTarget;
}): void => {
  switch (target.type) {
    case "decision": {
      writeDecisionPassage(dataTransfer, {
        caseNumber: target.caseNumber,
        court: target.court,
        decisionId: target.id,
        quote,
      });
      return;
    }
    case "statute": {
      dataTransfer.setData("text/plain", quote);
      dataTransfer.effectAllowed = "copy";
      return;
    }
    default: {
      target satisfies never;
      return panic(`Unhandled reader target: ${String(target)}`);
    }
  }
};
