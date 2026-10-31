import type {
  ReaderAnswer,
  ReaderAnswerCitation,
} from "@stll/api-contract/reader-answers";
import type { AnnotationAnchorSource } from "@stll/decision-reader/annotation-anchors";
import { readerBlockByAnchor } from "@stll/decision-reader/reader-landing";

export const readerAnswerAnchors = (
  answers: readonly ReaderAnswer[],
  activationLabel: string,
): AnnotationAnchorSource[] =>
  answers.flatMap(({ id, anchor }) =>
    anchor.spans.map((span) => ({
      id,
      blockAnchorId: span.paragraphId,
      startOffset: span.startOffset,
      endOffset: span.endOffset,
      kind: "highlight" as const,
      color: "sky" as const,
      style: "underline" as const,
      activationLabel,
    })),
  );

type OpenReaderAnswerFromMarkOptions = {
  id: string | null;
  answers: readonly ReaderAnswer[];
  onOpen: (answerId: string) => void;
};

export const openReaderAnswerFromMark = ({
  id,
  answers,
  onOpen,
}: OpenReaderAnswerFromMarkOptions): boolean => {
  if (id === null || !answers.some((answer) => answer.id === id)) {
    return false;
  }
  onOpen(id);
  return true;
};

type JumpReaderAnswerCitationOptions = {
  citation: ReaderAnswerCitation;
  decisionId: string;
  root: HTMLElement | null;
  openDecision: (
    decisionId: ReaderAnswerCitation["decisionId"],
    paragraphId: string,
  ) => Promise<void>;
};

export const jumpReaderAnswerCitation = async ({
  citation,
  decisionId,
  root,
  openDecision,
}: JumpReaderAnswerCitationOptions) => {
  if (citation.decisionId !== decisionId) {
    await openDecision(citation.decisionId, citation.paragraphId);
    return;
  }
  if (root === null) {
    return;
  }
  const paragraph = readerBlockByAnchor(root, citation.paragraphId);
  if (paragraph === null) {
    return;
  }
  for (
    let disclosure = paragraph.closest("details");
    disclosure !== null;
    disclosure = disclosure.parentElement?.closest("details") ?? null
  ) {
    disclosure.open = true;
  }
  paragraph.tabIndex = -1;
  paragraph.focus({ preventScroll: true });
  paragraph.scrollIntoView({ behavior: "instant", block: "center" });
};

type AttachReaderAnswerMarkersOptions = {
  root: HTMLElement;
  answers: readonly ReaderAnswer[];
  label: string;
  onOpen: (answerId: string) => void;
};

/** Markers keep answers reachable even when another annotation paints the same words. */
export const attachReaderAnswerMarkers = ({
  root,
  answers,
  label,
  onOpen,
}: AttachReaderAnswerMarkersOptions) => {
  const markers: HTMLButtonElement[] = [];
  for (const answer of answers) {
    const paragraph = readerBlockByAnchor(
      root,
      answer.anchor.spans[0].paragraphId,
    );
    if (paragraph === null) {
      continue;
    }
    const marker = root.ownerDocument.createElement("button");
    marker.type = "button";
    marker.textContent = "¶";
    marker.className = "reader-chrome text-muted-foreground px-1 text-xs";
    marker.dataset["readerChrome"] = "";
    marker.dataset["readerAnswerMarker"] = answer.id;
    marker.setAttribute("aria-label", label);
    marker.addEventListener("click", () => onOpen(answer.id));
    paragraph.append(marker);
    markers.push(marker);
  }
  return () => {
    for (const marker of markers) {
      marker.remove();
    }
  };
};
