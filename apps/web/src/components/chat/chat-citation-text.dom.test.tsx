import type { ComponentProps, ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";

import { CHAT_RESOURCE_HREF_PREFIX } from "@stll/api-contract";
import { toSafeId } from "@stll/api-contract/safe-id";
import {
  createStatutePath,
  createStatuteRouteParams,
} from "@stll/api-contract/statute-route";
import { assertProperty } from "@stll/property-testing";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";

import { dockedChatLegalPayloads } from "../../../e2e/helpers/docked-chat-legal-payloads";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
const { render, cleanup, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { decisionOptions } =
  await import("@/features/case-law/queries/decisions");
const { MessageResponseImpl } =
  await import("@/components/ai-elements/message-response");
const { ChatAnswerDecisionProvider } = await import("./chat-decision-citation");
const { StreamdownMentionLink } = await import("./streamdown-mention-link");
const { useExternalSourceStore } = await import("./external-source-store");
const messages = (await import("@/i18n/langs/en.json")).default;

const decision = (
  id: string,
  fields: Pick<
    PublicCaseLawDecision,
    "caseNumber" | "country" | "court" | "courtAbbreviation" | "language"
  >,
) =>
  ({
    ...dockedChatLegalPayloads.decision,
    ...fields,
    courtTier: "supreme",
    id: toSafeId<"caseLawDecision">(id),
    identifiers: [],
    slug: `synthetic-${id.slice(-4)}`,
  }) satisfies PublicCaseLawDecision;

const CZ_SUPREME = { court: "Nejvyšší soud", courtAbbreviation: "NS" } as const;
const DECISIONS = {
  example: decision("019a0000-0000-7000-8000-000000000201", {
    ...CZ_SUPREME,
    caseNumber: "33 Cdo 957/2026",
    country: "CZE",
    language: "cs",
  }),
  likewise: decision("019a0000-0000-7000-8000-000000000202", {
    ...CZ_SUPREME,
    caseNumber: "30 Cdo 3047/2012",
    country: "CZE",
    language: "cs",
  }),
  constitutional: decision("019a0000-0000-7000-8000-000000000203", {
    court: "Ústavní soud",
    courtAbbreviation: "ÚS",
    caseNumber: "III. ÚS 2429/24",
    country: "CZE",
    language: "cs",
  }),
  slovak: decision("019a0000-0000-7000-8000-000000000204", {
    court: "Najvyšší súd Slovenskej republiky",
    courtAbbreviation: "NS",
    caseNumber: "5 Cdo 12/2020",
    country: "SVK",
    language: "sk",
  }),
} as const;

const link = (target: PublicCaseLawDecision) =>
  `[${target.caseNumber}](${CHAT_RESOURCE_HREF_PREFIX.case_law_decision}${target.id})`;

const STATUTE = createStatutePath(
  createStatuteRouteParams({
    country: "cze",
    documentId: "019a0000-0000-7000-8000-000000000210",
    eli: "/eli/cz/sb/1963/99",
    slug: "99-1963-sb-obcansky-soudni-rad",
    version: null,
  }),
);

const clients: InstanceType<typeof QueryClient>[] = [];

const LINK_COMPONENTS = {
  a: (props: ComponentProps<"a">) => (
    <StreamdownMentionLink {...props} interactive />
  ),
};

const mount = (children: ReactNode) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  clients.push(client);
  for (const cached of Object.values(DECISIONS)) {
    client.setQueryData(decisionOptions(cached.id).queryKey, cached);
  }
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

/** Renders one answer the way a settled chat answer renders, anchors included. */
const renderAnswer = async (
  markdown: string,
  ready?: { selector: string; count: number },
) => {
  const message = {
    id: "answer",
    role: "assistant",
    parts: [{ type: "text", content: markdown }],
  } satisfies ChatUIMessage;
  const view = mount(
    <ChatAnswerDecisionProvider isAwaitingUser={false} message={message}>
      <MessageResponseImpl components={LINK_COMPONENTS} sourceOffsets>
        {markdown}
      </MessageResponseImpl>
    </ChatAnswerDecisionProvider>,
  );
  const decisionLinks =
    markdown.split(CHAT_RESOURCE_HREF_PREFIX.case_law_decision).length - 1;
  const { selector, count } = ready ?? {
    selector: "[data-decision-citation]",
    count: decisionLinks,
  };
  await waitFor(() => {
    expect(view.container.querySelectorAll(selector).length).toBe(count);
  });
  return view.container;
};

const paragraphText = (container: HTMLElement) =>
  (container.querySelector("p")?.textContent ?? "").replaceAll(/\s+/gu, " ");

const badgeCount = (container: HTMLElement) =>
  container.querySelectorAll('[data-slot="court-badge"]').length;

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  useExternalSourceStore.setState({ sourcesByUrl: {} });
});
afterAll(async () => unregisterDomEnvironment());

describe("a decision citation after prose that names its court", () => {
  const cases = [
    {
      name: "cs abbreviation",
      markdown: `Příklad z NS ${link(DECISIONS.example)}`,
      text: "Příklad z NS 33 Cdo 957/2026",
    },
    {
      name: "cs abbreviation after an adverb",
      markdown: `Shodně NS ${link(DECISIONS.likewise)}`,
      text: "Shodně NS 30 Cdo 3047/2012",
    },
    {
      name: "cs declined full name and decision kind",
      markdown: `Podle Nejvyššího soudu v rozsudku ${link(DECISIONS.likewise)}`,
      text: "Podle Nejvyššího soudu v rozsudku 30 Cdo 3047/2012",
    },
    {
      name: "cs full name of the constitutional court",
      markdown: `Ústavní soud v nálezu ${link(DECISIONS.constitutional)}`,
      text: "Ústavní soud v nálezu III. ÚS 2429/24",
    },
    {
      name: "en abbreviation",
      markdown: `Example from the NS ${link(DECISIONS.example)}`,
      text: "Example from the NS 33 Cdo 957/2026",
    },
    {
      name: "en abbreviation in parentheses",
      markdown: `Likewise the Supreme Court (NS) in ${link(DECISIONS.likewise)}`,
      text: "Likewise the Supreme Court (NS) in 30 Cdo 3047/2012",
    },
    {
      name: "sk abbreviation",
      markdown: `Príklad z NS ${link(DECISIONS.slovak)}`,
      text: "Príklad z NS 5 Cdo 12/2020",
    },
    {
      name: "sk declined full name",
      markdown: `Rovnako rozhodol Najvyšší súd v uznesení ${link(DECISIONS.slovak)}`,
      text: "Rovnako rozhodol Najvyšší súd v uznesení 5 Cdo 12/2020",
    },
  ] as const;

  for (const { name, markdown, text } of cases) {
    test(`${name}: the court is said once`, async () => {
      const container = await renderAnswer(markdown);
      expect(paragraphText(container)).toBe(text);
      expect(badgeCount(container)).toBe(0);
    });
  }
});

describe("a decision citation after prose that does not name its court", () => {
  test("keeps its badge, in the text's face, with an unbreakable case number", async () => {
    const container = await renderAnswer(
      `Podle rozsudku ${link(DECISIONS.example)} rozhoduje celkový obraz.`,
    );
    const text = paragraphText(container);
    expect(text.startsWith("Podle rozsudku NS")).toBe(true);
    expect(text.endsWith("33 Cdo 957/2026 rozhoduje celkový obraz.")).toBe(
      true,
    );
    const badge = container.querySelector('[data-slot="court-badge"]');
    expect(badge?.textContent).toBe("NS");
    expect(badge?.className).not.toContain("font-mono");
    // The badge and the case number travel as one unbreakable run.
    const run = badge?.parentElement?.closest(".whitespace-nowrap");
    expect(run?.textContent).toContain("33 Cdo 957/2026");
  });

  test("a different court named before it does not hide its badge", async () => {
    const container = await renderAnswer(
      `Jinak než Ústavní soud rozhodl ${link(DECISIONS.example)}.`,
    );
    expect(badgeCount(container)).toBe(1);
  });
});

describe("a decision citation whose read fails", () => {
  test("stays the answer's words, with the error and retry only in its peek", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () => Response.json({ error: "unavailable" }, { status: 500 }),
      { preconnect: () => undefined },
    );
    try {
      const unread = decision("019a0000-0000-7000-8000-000000000299", {
        ...CZ_SUPREME,
        caseNumber: "III. ÚS 2429/24",
        country: "CZE",
        language: "cs",
      });
      const prose = `Ústavní soud v nálezu ${unread.caseNumber} ze dne 15. 4. 2026 ale vymezil, že to platí jen tam.`;
      const container = await renderAnswer(
        `Ústavní soud v nálezu ${link(unread)} ze dne 15. 4. 2026 ale vymezil, že to platí jen tam.`,
        { selector: '[data-citation-unread="error"]', count: 1 },
      );
      // Not one word of status, error or retry copy joins the sentence.
      expect(paragraphText(container)).toBe(prose);
      expect(container.querySelector('p [role="alert"]') === null).toBe(true);
      expect(container.querySelector("p button") === null).toBe(true);
      const marked = container.querySelector('[data-citation-unread="error"]');
      expect(marked?.textContent).toBe(unread.caseNumber);
      expect(marked?.className).toContain("underline");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("a provision citation in parentheses", () => {
  const cases = [
    {
      name: "written tight",
      markdown: `Rozhoduje senát ([§ 240 odst. 1](${STATUTE}#par_240)).`,
      text: "Rozhoduje senát (§ 240 odst. 1).",
    },
    {
      name: "written with inner spaces",
      markdown: `Odvolání je přípustné ( [§ 57 o. s. ř.](${STATUTE}#par_57) ) ve lhůtě.`,
      text: "Odvolání je přípustné (§ 57 o. s. ř.) ve lhůtě.",
    },
    {
      name: "en, inside emphasis",
      markdown: `The panel decides *( [Section 240(1)](${STATUTE}#par_240) )*.`,
      text: "The panel decides (Section 240(1)).",
    },
  ] as const;

  for (const { name, markdown, text } of cases) {
    test(`${name}: renders tight, as prose`, async () => {
      const container = await renderAnswer(markdown);
      expect(paragraphText(container)).toBe(text);
      // A provision is the answer's own words, so nothing boxes it away from
      // the brackets around it.
      const citation = container.querySelector('a[href*="99-1963-sb"]');
      expect(citation?.className).toContain("underline");
      expect(citation?.querySelector('[role="group"]')).toBeNull();
      // Dropping the spaces keeps every anchored character mapped to its
      // place in the source.
      for (const anchored of container.querySelectorAll<HTMLElement>(
        "[data-src-offsets]",
      )) {
        const offsets = anchored.dataset["srcOffsets"]?.split(",") ?? [];
        expect(offsets).toHaveLength(anchored.textContent.length + 1);
      }
    });
  }
});

// Lead-ins a model writes before a citation, in the languages Stella answers
// in; each names the court or not, which is what the badge must follow.
const NAMING_LEAD_INS = [
  "Příklad z NS",
  "Shodně NS",
  "shodně ns",
  "Viz Nejvyšší soud v rozsudku",
  "Podle Nejvyššího soudu",
  "Likewise the NS in",
  "As the NS held in",
];
const NEUTRAL_LEAD_INS = ["Podle rozsudku", "Viz", "As held in", "Srov. též"];
const PAREN_SPACING = ["", " ", "  ", " "];

describe("citation text", () => {
  test("never repeats the court word and never leaves a loose bracket", async () => {
    await assertProperty(
      "never repeats the court word and never leaves a loose bracket",
      fc.asyncProperty(
        fc.oneof(
          fc.constantFrom(...NAMING_LEAD_INS).map((leadIn) => ({
            leadIn,
            names: true,
          })),
          fc.constantFrom(...NEUTRAL_LEAD_INS).map((leadIn) => ({
            leadIn,
            names: false,
          })),
        ),
        fc.boolean(),
        fc.constantFrom(...PAREN_SPACING),
        fc.constantFrom(...PAREN_SPACING),
        async ({ leadIn, names }, parenthesized, open, close) => {
          const citation = link(DECISIONS.example);
          const markdown = parenthesized
            ? `${leadIn} (${open}${citation}${close}) platí.`
            : `${leadIn} ${citation} platí.`;
          const container = await renderAnswer(markdown);
          const text = paragraphText(container);
          expect(text.toLocaleLowerCase("und")).not.toMatch(
            /(?:^|[^\p{L}])ns\s*\(?\s*ns(?:[^\p{L}]|$)/u,
          );
          expect(badgeCount(container)).toBe(names ? 0 : 1);
          expect(text).not.toMatch(/\(\s|\s\)/u);
          cleanup();
        },
      ),
      { numRuns: 24 },
    );
  });
});
