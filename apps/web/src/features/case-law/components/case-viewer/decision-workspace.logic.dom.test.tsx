import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { plugin } from "bun";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import {
  type DecisionAnalysis,
  parsePersistedDecisionAnalysis,
} from "@stll/legal-ast/analysis";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { aiAvailableResponse } from "@/__fixtures__/ai-availability";
import type { AnalysisQueryResult } from "@/features/case-law/queries/decision-analysis";
import { unregisterDomEnvironment } from "@/test-dom-environment";

// A DOM for this file only: the notes are rendered for real and the column's
// click is answered from the elements a reader actually hits.
GlobalRegistrator.register({ url: "http://localhost:3000/law" });
plugin({
  name: "worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});

const { cleanup, fireEvent, isInaccessible, render, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { MarginNotes } =
  await import("@/features/case-law/components/case-viewer/analysis/margin-notes");
const { decisionAnalysisOptions } =
  await import("@/features/case-law/queries/decision-analysis");
const { clickOpensVisitorOffer, READER_ASIDE_RESIZE_SLOT } =
  await import("@/features/case-law/components/case-viewer/decision-workspace.logic");
const { default: messages } = await import("@/i18n/langs/en.json");
const { toSafeId } = await import("@/lib/safe-id");
const { ActionCapabilitiesProvider } =
  await import("@/lib/organization/feature-access/capability-actions");
const { resolveActionCapabilities } =
  await import("@/lib/organization/feature-access/action-capabilities.logic");
const { DecisionWorkspace } = await import("./decision-workspace");

const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

const EXAMPLE_HEADING = "Facts";
const COMMENT_TEXT = "My own words.";

/** The mix a visitor's column holds: an example note beside a comment they
 *  wrote without an account and one they are writing now. */
const renderVisitorColumn = () =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <aside>
        <MarginNotes
          items={[
            {
              category: "facts",
              depth: 0,
              heading: EXAMPLE_HEADING,
              id: "example:facts",
              kind: "example",
              lines: [0.8, 0.4],
              startAnchorId: "p-1",
            },
            {
              author: { image: null, name: "Visitor" },
              id: "comment-1",
              kind: "comment",
              mine: true,
              onDelete: () => undefined,
              onToggleVisibility: () => undefined,
              startAnchorId: "p-2",
              text: COMMENT_TEXT,
              visibility: "private",
            },
            {
              id: "composer",
              kind: "composer",
              onCancel: () => undefined,
              onSubmit: () => undefined,
              startAnchorId: "p-3",
            },
          ]}
          placement="inline"
        />
        <div data-slot={READER_ASIDE_RESIZE_SLOT} data-testid="resize" />
      </aside>
    </IntlProvider>,
  );

const FOCUSABLE =
  "a[href], button, input, select, textarea, [tabindex], [contenteditable]";

describe("the visitor's notes column", () => {
  test("never asks for an account from the reader's own comments", () => {
    const view = renderVisitorColumn();
    const form = view.container.querySelector("form");
    const comment = view.getByText(COMMENT_TEXT).parentElement;
    if (form === null || comment === null) {
      throw new Error("the comment notes did not render");
    }
    const controls = [
      ...form.querySelectorAll(FOCUSABLE),
      ...comment.querySelectorAll(FOCUSABLE),
      form,
      view.getByText(COMMENT_TEXT),
    ];

    // Composer textarea, visibility toggle, Cancel, Save; the comment's
    // visibility toggle and Delete.
    expect(controls.length).toBeGreaterThanOrEqual(8);
    for (const control of controls) {
      expect(clickOpensVisitorOffer(control)).toBe(false);
    }
  });

  test("asks from the column's surface and its example notes", () => {
    const view = renderVisitorColumn();
    const aside = view.container.querySelector("aside");

    expect(clickOpensVisitorOffer(aside)).toBe(true);
    expect(clickOpensVisitorOffer(view.getByText(EXAMPLE_HEADING))).toBe(true);
    expect(clickOpensVisitorOffer(view.getByTestId("resize"))).toBe(false);
  });

  test("draws example notes as decoration, out of the tab order and the accessibility tree", () => {
    const view = renderVisitorColumn();
    const heading = view.getByText(EXAMPLE_HEADING);
    const example = heading.closest('[aria-hidden="true"]');

    expect(example).not.toBeNull();
    expect(example?.querySelectorAll(FOCUSABLE)).toHaveLength(0);
    expect(example?.matches(FOCUSABLE)).toBe(false);
    expect(
      within(view.container).queryByRole("button", { name: EXAMPLE_HEADING }),
    ).toBeNull();
    expect(isInaccessible(heading)).toBe(true);
  });
});

const user = {
  activeOrganizationId: "test-org",
  id: "test-reader",
  email: "reader@example.test",
  image: null,
  name: "Reader",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const rangeAst = {
  version: 1,
  source: { documentId: "1", printUrl: "", system: "test", webUrl: "" },
  metadata: {
    caseNumber: "1 As 1/2026",
    court: "Test court",
    decisionDate: null,
    decisionType: "Judgment",
    ecli: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    { anchorId: "p-1", number: 6, plainText: "Before the range" },
    { anchorId: "p-2", number: 9, plainText: "Range start" },
    { anchorId: "p-3", number: 10, plainText: "Range middle" },
    { anchorId: "p-4", number: 12, plainText: "Range end" },
  ].map(({ anchorId, number, plainText }) => ({
    id: anchorId,
    anchorId,
    number,
    type: "paragraph" as const,
    plainText,
    inlines: [{ type: "text" as const, text: plainText }],
  })),
} satisfies DocumentAst;
const absent = {
  reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
  type: TEXT_FIELD_TYPE.ABSENT,
} as const;
const rangeDecision = {
  id: toSafeId<"caseLawDecision">("00000000-0000-4000-8000-000000000102"),
  caseNumber: "1 As 1/2026",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  country: "CZE",
  court: "Test court",
  courtAbbreviation: null,
  courtTier: "other",
  decisionDate: null,
  decisionType: "Judgment",
  ecli: null,
  documentAst: rangeAst,
  documentPending: false,
  documentReadFailed: false,
  documentUnavailable: false,
  fulltext: null,
  judges: [],
  language: "en",
  metadata: {},
  sourceAttributionUrl: null,
  source: {
    id: toSafeId<"caseLawSource">("00000000-0000-4000-8000-000000000103"),
    name: "Test publisher",
    adapterKey: "test",
    allowsDerivedAi: true,
  },
  textFields: {
    abstract: absent,
    headnote: absent,
    legalSentence: absent,
    summary: absent,
  },
  updatedAt: "2026-10-18T12:00:00Z",
} satisfies ComponentProps<typeof DecisionWorkspace>["decision"];
const rangeAnalysis = {
  version: 4,
  generatedAt: rangeDecision.updatedAt,
  model: "test",
  inputFingerprint: "a".repeat(64),
  tree: [],
  holding: {
    spans: [
      {
        text: "The cited paragraphs establish the holding.",
        anchors: [{ startAnchorId: "p-2", endAnchorId: "p-4" }],
      },
    ],
    language: "en",
  },
  abstract: { spans: [{ text: "A summary.", anchors: [] }], language: "en" },
  topics: [],
} satisfies DecisionAnalysis;

const installWorkspaceServer = () => {
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/provisions")) {
        return Response.json({
          items: [],
          previews: [],
          nextCursor: null,
          status: { type: "current" },
          generation: null,
        });
      }
      if (
        path.endsWith("/reader/annotations") ||
        path.endsWith("/reader/answers") ||
        path.endsWith("/citations")
      ) {
        return Response.json({ items: [], nextCursor: null });
      }
      if (path.endsWith("/organization-settings/ai-availability")) {
        return Response.json(aiAvailableResponse());
      }
      if (path.endsWith("/workspaces/navigation")) {
        return Response.json({ items: [], nextCursor: null, workspaces: [] });
      }
      if (/\/chat\/threads\/[^/]+\/messages$/u.test(path)) {
        return Response.json({ message: "Not found" }, { status: 404 });
      }
      throw new TypeError(`Unexpected request: ${request.method} ${path}`);
    },
    { preconnect: originalFetch.preconnect },
  );
};

test("an inline holding reference highlights its full range and scrolls to its start", async () => {
  installWorkspaceServer();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const persistedAnalysis = parsePersistedDecisionAnalysis(rangeAnalysis);
  if (persistedAnalysis === null || "status" in persistedAnalysis) {
    throw new TypeError("Completed analysis fixture must parse");
  }
  client.setQueryData(
    decisionAnalysisOptions({
      decisionId: rangeDecision.id,
      decisionUpdatedAt: rangeDecision.updatedAt,
    }).queryKey,
    () =>
      ({
        kind: "done",
        analysis: persistedAnalysis,
      }) satisfies AnalysisQueryResult,
  );
  const root = createRootRoute({
    component: () => (
      <ChatEditorProvider>
        <DecisionWorkspace
          aiMode="enabled"
          decision={rangeDecision}
          decisionId={rangeDecision.id}
          ensureAIAvailable={async () => true}
        />
      </ChatEditorProvider>
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={client}>
      <AuthenticatedUserProvider user={user}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <ActionCapabilitiesProvider
              value={resolveActionCapabilities({
                role: "member",
                ai: true,
                deepl: false,
                ocr: false,
                desktop: "none",
                settings: undefined,
              })}
            >
              <WebReaderPresentationProvider>
                <RouterProvider router={router} />
              </WebReaderPresentationProvider>
            </ActionCapabilitiesProvider>
          </FormattingProvider>
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>,
  );
  const reader = view.container.querySelector<HTMLElement>(".reader-scroll");
  const start = view.container.querySelector<HTMLElement>("#p-2");
  if (!reader || !start) {
    throw new TypeError("Decision reader range did not render");
  }
  const scrollTo = mock(() => undefined);
  reader.scrollTo = scrollTo;
  reader.getBoundingClientRect = () => new DOMRect(0, 10, 1000, 400);
  start.getBoundingClientRect = () => new DOMRect(320, 90, 680, 40);
  Object.defineProperty(reader, "scrollTop", {
    configurable: true,
    value: 7,
  });

  fireEvent.click(view.getByRole("button", { name: "Paragraph 9–12" }));

  expect(scrollTo).toHaveBeenCalledWith({ top: 87, behavior: "instant" });
  for (const anchorId of ["p-2", "p-3", "p-4"]) {
    expect(
      view.container.querySelector<HTMLElement>(`#${anchorId}`)?.dataset[
        "highlight"
      ],
    ).toBe("");
  }
  expect(
    view.container.querySelector<HTMLElement>("#p-1")?.dataset["highlight"],
  ).toBeUndefined();
});
