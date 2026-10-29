import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

import type { CaseLawDecisionSummary } from "@stll/api-contract/case-law-decision-summary";
import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import type { CitationAnchorSource } from "@stll/decision-reader/reader-types";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

// A card reads only the cited decision's stored summary: the held one is
// seeded below, the missing one answers 404. Any other request (the citing
// passage, the full decision) is a regression.
const originalFetch = globalThis.fetch;
const requests: string[] = [];
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    return url.endsWith("/summary")
      ? Response.json({ message: "Decision not found" }, { status: 404 })
      : Response.json({ message: "Unexpected read" }, { status: 500 });
  },
  { preconnect: () => undefined },
);

const { act, cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
const { WebDecisionReader } =
  await import("@/components/legal-reader/web-decision-reader");
const { decisionCardSummaryOptions } =
  await import("@/features/case-law/queries/decisions");
const { default: messages } = await import("@/i18n/langs/en.json");
const { toSafeId } = await import("@/lib/safe-id");

const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  requests.length = 0;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const CITED_CASE = "II. ÚS 2495/26";
const CITED_REFERENCE = `sp.\u00a0zn. ${CITED_CASE}`;
const MISSING_CASE = "21 Cdo 1234/2025";
const CITING_WORDS = "stěžovatel se dovolává závěrů";
const CITING_PARAGRAPH = `Jak ${CITING_WORDS} nálezu ${CITED_REFERENCE} a usnesení sp. zn. ${MISSING_CASE}.`;
const LATER_PARAGRAPH = `Soud připomíná, že ${CITED_CASE} je třeba číst spolu s ${CITED_CASE}.`;
const HEADNOTE = "A court that ignores settled case law must explain why.";

const paragraph = (id: string, text: string, number: number) => ({
  anchorId: `anchor-${id}`,
  id,
  inlines: [{ text, type: "text" as const }],
  number,
  plainText: text,
  type: "paragraph" as const,
});

const ast = {
  blocks: [
    {
      ...paragraph("citing", CITING_PARAGRAPH, 4),
      // Mirrors publisher runs around punctuation and a non-breaking space.
      inlines: [
        { text: `Jak ${CITING_WORDS} nálezu sp`, type: "text" as const },
        { text: ".\u00a0", type: "text" as const },
        { text: "zn. II. ", type: "text" as const },
        { text: "ÚS 2495/26", type: "text" as const },
        {
          text: ` a usnesení sp. zn. ${MISSING_CASE}.`,
          type: "text" as const,
        },
      ],
    },
    paragraph("later", LATER_PARAGRAPH, 12),
  ],
  metadata: {
    caseNumber: "III. ÚS 2900/26",
    court: "Ústavní soud",
    decisionDate: null,
    decisionType: "nález",
    ecli: null,
    keywords: [],
    statutes: [],
  },
  source: { documentId: "1", printUrl: "", system: "test", webUrl: "" },
  version: 1,
} satisfies DocumentAst;

const absent = {
  reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
  type: TEXT_FIELD_TYPE.ABSENT,
} as const;

const decision = {
  caseNumber: "III. ÚS 2900/26",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  country: "CZE",
  court: "Ústavní soud",
  courtAbbreviation: "ÚS",
  courtTier: "constitutional",
  documentAst: ast,
  documentPending: false,
  documentReadFailed: false,
  documentUnavailable: false,
  fulltext: null,
  id: toSafeId<"caseLawDecision">("9b1f0f3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
  judges: [],
  language: "cs",
  sourceAttributionUrl: null,
  textFields: {
    abstract: absent,
    headnote: absent,
    legalSentence: absent,
    summary: absent,
  },
} satisfies ComponentProps<typeof WebDecisionReader>["decision"];

const citedId = toSafeId<"caseLawDecision">(
  "4d2c6c1e-8a3b-4f5e-9d7c-1a2b3c4d5e6f",
);
// Resolved by the citation graph, but the public corpus does not serve it.
const missingId = toSafeId<"caseLawDecision">(
  "7e3d5f2a-1b4c-4d6e-8f9a-0b1c2d3e4f5a",
);

const resolved = [
  {
    citationText: CITED_REFERENCE,
    decision: {
      caseNumber: CITED_CASE,
      caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      country: "CZE",
      court: "Ústavní soud",
      courtAbbreviation: "ÚS",
      decisionDate: "2026-03-04",
      ecli: null,
      id: citedId,
      language: "cs",
      languageAlternates: null,
      slug: null,
      sourceUrl: "https://nalus.example.test/ii-us-2495-26",
    },
    id: "citation-held",
    treatment: "neutral",
  },
  {
    citationText: `sp. zn. ${MISSING_CASE}`,
    decision: {
      caseNumber: MISSING_CASE,
      caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      country: "CZE",
      court: "Nejvyšší soud",
      courtAbbreviation: "NS",
      decisionDate: null,
      ecli: null,
      id: missingId,
      language: "cs",
      languageAlternates: null,
      slug: null,
      sourceUrl: "https://nsoud.example.test/21-cdo-1234-2025",
    },
    id: "citation-missing",
    treatment: "neutral",
  },
] satisfies CitationAnchorSource[];

const summary = {
  caseNumber: CITED_CASE,
  citationCount: 2,
  court: "Ústavní soud",
  courtAbbreviation: "ÚS",
  courtTier: "constitutional",
  decisionDate: "2026-03-04",
  decisionType: "nález",
  headnote: { text: HEADNOTE, truncated: false, type: TEXT_FIELD_TYPE.PRESENT },
  id: citedId,
  publication: null,
} satisfies CaseLawDecisionSummary;

const renderReader = async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  clients.push(client);
  client.setQueryData(decisionCardSummaryOptions(citedId).queryKey, summary);
  const root = createRootRoute({
    component: () => (
      <WebDecisionReader
        annotationAnchors={[
          {
            blockAnchorId: "anchor-citing",
            color: "yellow",
            endOffset: CITING_PARAGRAPH.indexOf(CITED_CASE) + 5,
            id: "topic-over-citation",
            kind: "highlight",
            startOffset: CITING_PARAGRAPH.indexOf("zn."),
            style: "underline",
          },
        ]}
        surface="development"
        citationAnchors={resolved}
        decision={decision}
        decisionId={decision.id}
        isHydrated
      />
    ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root,
  });
  await router.load();
  return render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <WebReaderPresentationProvider>
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </WebReaderPresentationProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
};

const popup = async () => {
  const element = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      '[data-slot="popover-popup"]',
    );
    expect(found).not.toBeNull();
    return found;
  });
  return element ?? document.body;
};

describe("a citation card in the decision text", () => {
  test("a citation split by text runs, an overlapping mark, and an NBSP owns one court badge", async () => {
    const view = await renderReader();
    const paragraphElement = view.container.querySelector<HTMLElement>(
      '[data-anchor="anchor-citing"]',
    );
    expect(paragraphElement).not.toBeNull();
    expect(
      paragraphElement?.querySelectorAll('[data-slot="court-badge"]'),
    ).toHaveLength(2);

    const citationLinks = paragraphElement?.querySelectorAll(
      `[data-decision-citation="${citedId}"]`,
    );
    expect(citationLinks).toHaveLength(4);
    const citationText = Array.from(citationLinks ?? [])
      .map((link) => {
        const copy = link.cloneNode(true);
        if (!(copy instanceof Element)) {
          return "";
        }
        for (const node of copy.querySelectorAll("[data-reader-chrome]")) {
          node.remove();
        }
        return copy.textContent;
      })
      .join("");
    expect(citationText).toBe(CITED_REFERENCE);
    expect(
      Array.from(citationLinks ?? []).flatMap((link) =>
        Array.from(link.querySelectorAll('[data-slot="court-badge"]')),
      ),
    ).toHaveLength(1);
  });

  test("describes the cited decision and offers its other mentions without echoing the citing paragraph", async () => {
    const view = await renderReader();
    const trigger = view.container.querySelector<HTMLElement>(
      `[data-anchor="anchor-citing"] [data-decision-citation="${citedId}"]`,
    );
    expect(trigger).not.toBeNull();
    // The reader shows the paragraph; the card must not show it a second time.
    expect(view.container.textContent).toContain(CITING_WORDS);

    await act(async () => {
      trigger?.focus();
    });
    const card = await popup();
    const inCard = within(card);

    expect(inCard.getByText("Ústavní soud")).toBeTruthy();
    expect(inCard.getByText(CITED_CASE)).toBeTruthy();
    expect(inCard.getByText("Mar 4, 2026")).toBeTruthy();
    expect(inCard.getByText("nález")).toBeTruthy();
    expect(inCard.getByText(HEADNOTE)).toBeTruthy();
    expect(
      inCard.getByRole("link", { name: messages.common.openInStella }),
    ).toBeTruthy();
    expect(card.textContent).not.toContain(CITING_WORDS);
    expect(card.textContent).not.toContain(LATER_PARAGRAPH);
    expect(inCard.getByText("Cited 3 times in this decision")).toBeTruthy();
    expect(inCard.getByText("¶ 4").getAttribute("aria-current")).toBe(
      "location",
    );
    expect(
      inCard.queryByRole("button", { name: "Go to paragraph 4" }),
    ).toBeNull();
    expect(requests).toEqual([]);

    const scrolled: HTMLElement[] = [];
    const scroll = spyOn(
      HTMLElement.prototype,
      "scrollIntoView",
    ).mockImplementation(function (this: HTMLElement) {
      scrolled.push(this);
    });
    try {
      await act(async () => {
        fireEvent.click(
          inCard.getByRole("button", { name: "Go to paragraph 12" }),
        );
      });
      expect(scrolled.map((element) => element.dataset["anchor"])).toEqual([
        "anchor-later",
      ]);
      await waitFor(() => {
        expect(
          document.querySelector('[data-slot="popover-popup"]'),
        ).toBeNull();
      });
    } finally {
      scroll.mockRestore();
    }
  });

  test("names a cited decision the corpus does not hold by what the citation established, and Escape closes it", async () => {
    const view = await renderReader();
    const trigger = view.container.querySelector<HTMLElement>(
      `[data-decision-citation="${missingId}"]`,
    );
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.focus();
    });
    const card = await popup();
    const inCard = within(card);

    expect(
      await inCard.findByText(messages.caseLaw.citation.notInStella),
    ).toBeTruthy();
    expect(inCard.getByText(MISSING_CASE)).toBeTruthy();
    expect(inCard.getByText("Nejvyšší soud")).toBeTruthy();
    expect(inCard.queryByRole("alert")).toBeNull();
    expect(card.textContent).not.toContain(CITING_WORDS);
    expect(
      inCard.getByRole("link", {
        name: messages.inspector.external.openOriginal,
      }),
    ).toBeTruthy();
    expect(requests.map((url) => new URL(url).pathname)).toEqual([
      expect.stringMatching(
        new RegExp(`/case/decisions/${missingId}/summary$`, "u"),
      ),
    ]);

    await act(async () => {
      fireEvent.keyDown(card, { key: "Escape" });
    });
    await waitFor(() => {
      expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
    expect(
      screen.queryByText(messages.caseLaw.citation.notInStella),
    ).toBeNull();
  });
});
