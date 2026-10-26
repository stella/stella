/* oxlint-disable no-untranslated-jsx-literal/no-untranslated-jsx-literal -- Court text fixtures verify paragraph navigation, not product copy. */
/* oxlint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- The fixture delegates clicks; nested answer marks own Enter/Space activation. */
import { useState } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import type { ReaderAnswer } from "@stll/api-contract/reader-answers";
import { annotationTextAnchors } from "@stll/decision-reader/annotation-anchors";

import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import {
  attachReaderAnswerMarkers,
  jumpReaderAnswerCitation,
  openReaderAnswerFromMark,
  readerAnswerAnchors,
} from "./reader-answer-navigation";

GlobalRegistrator.register();
const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ReaderAnswerCard } = await import("./reader-answer-card");
const messages = (await import("@/i18n/langs/en.json")).default;
afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});
const answer = {
  id: toSafeId<"legalReaderAnswer">("00000000-0000-4000-8000-000000000001"),
  decisionId: toSafeId<"caseLawDecision">(
    "00000000-0000-4000-8000-000000000002",
  ),
  authorId: toSafeId<"user">("00000000-0000-4000-8000-000000000003"),
  mine: true,
  kind: "explain",
  visibility: "private",
  anchor: {
    spans: [
      {
        paragraphId: "p-12",
        quote: "Selected words",
        startOffset: 0,
        endOffset: 14,
      },
    ],
  },
  messages: [
    {
      id: toSafeId<"legalReaderAnswerMessage">(
        "00000000-0000-4000-8000-000000000004",
      ),
      role: "assistant",
      content: "Contextual answer",
      citations: [],
      status: "complete",
      errorCode: null,
      invalidCitationCount: 0,
      model: "fixture",
      usage: null,
      createdAt: "2026-10-10",
      updatedAt: "2026-10-10",
    },
  ],
  createdAt: "2026-10-10",
  updatedAt: "2026-10-10",
} satisfies ReaderAnswer;

const ReopenHarness = () => {
  const [revision, setRevision] = useState(0);
  const anchors = annotationTextAnchors(
    readerAnswerAnchors([answer], "Reopen passage answer"),
    answer.anchor.spans[0].quote,
  );
  return (
    <IntlProvider locale="en" messages={messages}>
      <div
        onClick={(event) => {
          const mark =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-annotation-id]")
              : null;
          openReaderAnswerFromMark({
            id: mark?.dataset["annotationId"] ?? null,
            answers: [answer],
            onOpen: () => setRevision((value) => value + 1),
          });
        }}
      >
        {anchors.at(0)?.render(answer.anchor.spans[0].quote)}
      </div>
      <ReaderAnswerCard
        answer={answer}
        generationMode="enabled"
        active
        openRevision={revision}
        busy={false}
        citationLabel={() => "¶48"}
        onOpen={() => undefined}
        onFollowUp={() => undefined}
        onRegenerate={() => undefined}
        onDelete={() => undefined}
        onVisibility={() => undefined}
        onCitation={() => undefined}
      />
    </IntlProvider>
  );
};

test("a persistent answered underline reopens the same minimised card", () => {
  const view = render(<ReopenHarness />);
  fireEvent.click(
    view.getByRole("button", { name: messages.readerAnswers.minimise }),
  );
  expect(view.queryByRole("textbox")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Reopen passage answer" }));
  expect(view.getByRole("textbox")).not.toBeNull();
  expect(view.getByText("Contextual answer")).not.toBeNull();
});

test("citation jump uses data-anchor, unfolds text and focuses the court paragraph", async () => {
  const view = render(
    <article>
      <p id="p-12" data-anchor="wrong">
        {"Decoy"}
      </p>
      <details>
        <summary>{"Reasoning"}</summary>
        <p id="block-internal-12" data-anchor="p-12">
          {"Court paragraph 48"}
        </p>
      </details>
    </article>,
  );
  const paragraph =
    view.container.querySelector<HTMLElement>("[data-anchor=p-12]");
  if (!paragraph) {
    throw new Error("Missing court paragraph fixture");
  }
  const scroll = mock(() => undefined);
  paragraph.scrollIntoView = scroll;
  const openDecision = mock(async () => undefined);
  await jumpReaderAnswerCitation({
    citation: { decisionId: answer.decisionId, paragraphId: "p-12" },
    decisionId: answer.decisionId,
    root: view.container,
    openDecision,
  });
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector("details")?.open).toBe(true);
  expect(view.container.ownerDocument.activeElement).toBe(paragraph);
  expect(openDecision).not.toHaveBeenCalled();
});

test("a foreign citation navigates with both validated decision and paragraph", async () => {
  const foreign = toSafeId<"caseLawDecision">(
    "00000000-0000-4000-8000-000000000005",
  );
  const openDecision = mock(async () => undefined);
  await jumpReaderAnswerCitation({
    citation: { decisionId: foreign, paragraphId: "p-6" },
    decisionId: answer.decisionId,
    root: null,
    openDecision,
  });
  expect(openDecision).toHaveBeenCalledWith(foreign, "p-6");
});

test("paragraph markers reopen answers when another mark overlaps, and detach cleanly", () => {
  const view = render(
    <article>
      <p data-anchor="p-12">{answer.anchor.spans[0].quote}</p>
    </article>,
  );
  const open = mock(() => undefined);
  const detach = attachReaderAnswerMarkers({
    root: view.container,
    answers: [answer],
    label: "Open answer",
    onOpen: open,
  });
  const marker = view.getByRole("button", { name: "Open answer" });
  expect(Object.hasOwn(marker.dataset, "readerChrome")).toBe(true);
  fireEvent.click(marker);
  expect(open).toHaveBeenCalledWith(answer.id);
  detach();
  expect(view.queryByRole("button", { name: "Open answer" })).toBeNull();
});
