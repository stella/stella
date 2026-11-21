import { useState } from "react";

import type { ReaderAnswer } from "@stll/api-contract/reader-answers";

import { ReaderAnswerCard } from "@/features/case-law/components/case-viewer/reader-answer-card";
import type { ReaderAnswerCitationTarget } from "@/features/case-law/components/case-viewer/reader-answer-citation.logic";
import { toSafeId } from "@/lib/safe-id";

const fixture = {
  id: toSafeId<"legalReaderAnswer">("00000000-0000-4000-8000-000000000811"),
  decisionId: toSafeId<"caseLawDecision">(
    "00000000-0000-4000-8000-000000000812",
  ),
  authorId: toSafeId<"user">("00000000-0000-4000-8000-000000000813"),
  mine: true,
  kind: "explain",
  visibility: "private",
  anchor: {
    spans: [
      {
        paragraphId: "p-12",
        quote: "The party must be given an opportunity to respond.",
        startOffset: 0,
        endOffset: 53,
      },
    ],
  },
  messages: [
    {
      id: toSafeId<"legalReaderAnswerMessage">(
        "00000000-0000-4000-8000-000000000814",
      ),
      role: "assistant",
      status: "complete",
      errorCode: null,
      invalidCitationCount: 0,
      content:
        "This passage requires the court to hear both parties before deciding the disputed issue. The following paragraph explains how the court applies that requirement to the facts.",
      citations: [
        {
          decisionId: toSafeId<"caseLawDecision">(
            "00000000-0000-4000-8000-000000000812",
          ),
          paragraphId: "p-13",
        },
      ],
      model: "fixture",
      usage: null,
      createdAt: "2026-10-10T12:00:00Z",
      updatedAt: "2026-10-10T12:00:00Z",
    },
  ],
  createdAt: "2026-10-10T12:00:00Z",
  updatedAt: "2026-10-10T12:00:00Z",
} satisfies ReaderAnswer;

const RESPONSE_PARAGRAPH =
  "The opportunity to respond gives each party a chance to explain their position before the court resolves the dispute.";

const citedParagraph = {
  type: "paragraph",
  reference: {
    startAnchorId: "p-13",
    endAnchorId: "p-13",
    startIndex: 1,
    endIndex: 1,
    label: "[13]",
    paragraphs: [{ anchorId: "p-13", number: "13", text: RESPONSE_PARAGRAPH }],
  },
} satisfies ReaderAnswerCitationTarget;

export const ReaderAnswersPlayground = () => {
  const [visibility, setVisibility] = useState<ReaderAnswer["visibility"]>(
    fixture.visibility,
  );
  const [openRevision, setOpenRevision] = useState(0);
  return (
    <div className="grid max-w-4xl gap-8 p-6 lg:grid-cols-[1fr_13.75rem]">
      <article className="reader-body space-y-4 leading-relaxed">
        <p data-anchor="p-12">
          <span className="underline decoration-dotted underline-offset-4">
            {fixture.anchor.spans[0].quote}
          </span>
        </p>
        <p data-anchor="p-13">{RESPONSE_PARAGRAPH}</p>
      </article>
      <ReaderAnswerCard
        answer={{ ...fixture, visibility }}
        generationMode="enabled"
        active={false}
        openRevision={openRevision}
        citationTarget={() => citedParagraph}
        language="en"
        onOpen={() => setOpenRevision((value) => value + 1)}
        onVisibility={setVisibility}
        onCitation={() => undefined}
        onFollowUp={() => undefined}
        onRegenerate={() => undefined}
        onDelete={() => undefined}
        busy={false}
      />
    </div>
  );
};
