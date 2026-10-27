// Guard: every citation surface draws its citations through `CitationChip`.
// The owner alone sets `data-citation-kind`, so a surface that draws its own
// button, or a chip without the owner, leaves a citation unmarked here.
import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { toChatDecisionPassageHref } from "@stll/api-contract";
import type {
  ReaderAnswer,
  ReaderAnswerCitation,
} from "@stll/api-contract/reader-answers";
import type { DecisionAnalysis } from "@stll/legal-ast/analysis";
import type { Block } from "@stll/legal-ast/document-ast";

import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import type { CitationKind } from "@/components/references/citation-chip";
import { decisionCitationMetadata } from "@/components/references/decision-citation-chip.logic";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import { dockedChatLegalPayloads } from "../../../e2e/helpers/docked-chat-legal-payloads";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { cleanup, render, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { decisionOptions } =
  await import("@/features/case-law/queries/decisions");
const { AiHeadnotes } =
  await import("@/features/case-law/components/case-viewer/analysis/ai-headnotes");
const { ReaderAnswerCard } =
  await import("@/features/case-law/components/case-viewer/reader-answer-card");
const { resolveReaderAnswerCitation } =
  await import("@/features/case-law/components/case-viewer/reader-answer-citation.logic");
const { ChatAnswerDecisionProvider, ChatDecisionCitation } =
  await import("@/components/chat/chat-decision-citation");
const messages = (await import("@/i18n/langs/en.json")).default;

const cited = {
  ...dockedChatLegalPayloads.decision,
  court: "Nejvyšší soud",
  courtAbbreviation: "NS",
} satisfies PublicCaseLawDecision;
const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => unregisterDomEnvironment());

const mount = (children: ReactNode) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  clients.push(client);
  client.setQueryData(decisionOptions(cited.id).queryKey, cited);
  return render(
    <ChatThreadTestRouter>
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <WebReaderPresentationProvider>
              {children}
            </WebReaderPresentationProvider>
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>
    </ChatThreadTestRouter>,
  );
};

/** The kinds the owner marked, in reading order. */
const citationKinds = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-citation-kind]")].map(
    (chip) => chip.dataset["citationKind"],
  );

/** No chip on the surface sits outside an owner mark of its own kind. */
const expectEveryChipOwned = (root: HTMLElement) => {
  for (const chip of root.querySelectorAll("[data-decision-citation]")) {
    expect(chip.closest('[data-citation-kind="decision"]')).not.toBeNull();
  }
  for (const chip of within(root).queryAllByRole("button", {
    name: /^Paragraph /u,
  })) {
    expect(chip.closest('[data-citation-kind="paragraph"]')).not.toBeNull();
  }
};

const OPEN_DECISION = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-000000000002",
);

const blocks = [
  {
    id: "nine",
    anchorId: "p-9",
    type: "paragraph",
    number: 9,
    inlines: [],
    plainText: "The court of appeal did not address the objection.",
  },
  {
    id: "ten",
    anchorId: "p-10",
    type: "paragraph",
    number: 10,
    inlines: [],
    plainText: "That omission breached the right to a fair trial.",
  },
] satisfies Block[];

test("headnote citations are paragraph chips drawn by the owner", () => {
  const analysis = {
    version: 4,
    generatedAt: "2026-10-18T00:00:00Z",
    model: "fixture-model",
    inputFingerprint: "citation-surface-headnote",
    tree: [],
    holding: {
      spans: [
        {
          text: "The complaint is well founded.",
          anchors: [
            { startAnchorId: "p-9", endAnchorId: "p-9" },
            { startAnchorId: "p-9", endAnchorId: "p-10" },
          ],
        },
      ],
      language: "en",
    },
    abstract: {
      spans: [
        {
          text: "The court annulled the judgment.",
          anchors: [{ startAnchorId: "p-10", endAnchorId: "p-10" }],
        },
      ],
      language: "en",
    },
    topics: [],
  } satisfies DecisionAnalysis;
  const { container } = mount(
    <AiHeadnotes
      analysis={analysis}
      blocks={blocks}
      language="en"
      onAnchorClick={() => undefined}
    />,
  );
  expect(citationKinds(container)).toEqual([
    "paragraph",
    "paragraph",
    "paragraph",
  ] satisfies CitationKind[]);
  expectEveryChipOwned(container);
});

test("reader answer citations pick the paragraph chip for the open decision and the decision chip for another", () => {
  const citations = [
    { decisionId: OPEN_DECISION, paragraphId: "p-9" },
    { decisionId: cited.id, paragraphId: "p-12" },
  ] satisfies ReaderAnswerCitation[];
  const answer = {
    id: toSafeId<"legalReaderAnswer">("00000000-0000-4000-8000-000000000001"),
    decisionId: OPEN_DECISION,
    authorId: toSafeId<"user">("00000000-0000-4000-8000-000000000003"),
    mine: false,
    kind: "explain",
    visibility: "shared",
    anchor: {
      spans: [
        {
          paragraphId: "p-9",
          quote: "objection",
          startOffset: 0,
          endOffset: 9,
        },
      ],
    },
    messages: [
      {
        id: toSafeId<"legalReaderAnswerMessage">(
          "00000000-0000-4000-8000-000000000004",
        ),
        role: "assistant",
        content: "The objection went unanswered.",
        citations,
        model: "fixture",
        usage: null,
        status: "complete",
        errorCode: null,
        invalidCitationCount: 0,
        createdAt: "2026-10-10",
        updatedAt: "2026-10-10",
      },
    ],
    createdAt: "2026-10-10",
    updatedAt: "2026-10-10",
  } satisfies ReaderAnswer;
  const { container } = mount(
    <ReaderAnswerCard
      answer={answer}
      generationMode="gated"
      active={false}
      openRevision={0}
      busy={false}
      language="en"
      citationTarget={(citation) =>
        resolveReaderAnswerCitation({
          citation,
          decisionId: OPEN_DECISION,
          blocks,
          formatNumber: String,
          readCitedDecision: () => ({
            type: "loaded",
            decision: decisionCitationMetadata(cited),
            blocks: [],
          }),
        })
      }
      onCitation={() => undefined}
      onOpen={() => undefined}
      onFollowUp={() => undefined}
      onRegenerate={() => undefined}
      onDelete={() => undefined}
      onVisibility={() => undefined}
    />,
  );
  expect(citationKinds(container)).toEqual([
    "paragraph",
    "decision",
  ] satisfies CitationKind[]);
  expectEveryChipOwned(container);
});

test("chat decision citations are decision chips drawn by the owner", async () => {
  const href = toChatDecisionPassageHref({
    decisionId: cited.id,
    anchorId: "p-12",
    courtParagraphNumber: null,
  });
  const message = {
    id: "answer",
    role: "assistant",
    parts: [{ type: "text", content: `[${cited.caseNumber}](${href})` }],
  } satisfies ChatUIMessage;
  const { container } = mount(
    <ChatAnswerDecisionProvider message={message} isAwaitingUser={false}>
      <p>
        <ChatDecisionCitation
          decisionId={cited.id}
          passage={cited.caseNumber}
          interactive
        />
      </p>
    </ChatAnswerDecisionProvider>,
  );
  await waitFor(() => {
    expect(citationKinds(container)).toEqual([
      "decision",
    ] satisfies CitationKind[]);
  });
  expectEveryChipOwned(container);
});
