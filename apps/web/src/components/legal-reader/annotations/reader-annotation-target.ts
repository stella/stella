import { panic } from "better-result";

import type { ReaderAnnotationTargetType } from "@stll/api-contract/legal-reader-annotations";

import {
  decisionPassageContent,
  writeDecisionPassage,
} from "@/components/chat-decision-passage";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { SelectionAnchor } from "@/components/legal-reader/annotations/selection-anchor";
import { openPublicLawChat } from "@/components/public-law-ask";
import { formatDecisionCitation } from "@/features/case-law/citation-format";
import { formatStatuteCitation } from "@/features/statutes/statute-format";
import {
  createChatDraftState,
  useChatDraftStore,
} from "@/lib/chat-draft-store";
import { createChatThreadId, getChatThreadKey } from "@/lib/chat-thread-ref";

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
      decisionDate: Date | string | null;
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
  switch (target.type) {
    case "decision": {
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
 * Opens a fresh inspector chat about the selected passage. A decision is a
 * resource the corpus tools can be handed, so the passage lands as chips with
 * the decision attached; a statute consolidation is not, so the prompt names
 * it in words the tools look it up by.
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
      const threadId = createChatThreadId();
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
        activeDecisionId: target.id,
        id: threadId,
        label: target.caseNumber,
      });
      return;
    }
    case "statute": {
      openPublicLawChat({ label: target.title, prompt });
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
