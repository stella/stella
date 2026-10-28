import { fireEvent, render } from "@testing-library/react";
import { expect, test } from "bun:test";

import {
  CASE_LAW_TEXT_STATUS,
  type CaseLawTextStatus,
} from "@stll/api-contract/case-law-text-status";
import { APP_SEARCH_FIXTURE } from "@stll/api-contract/mcp-app.fixtures";
import { DECISION_SEARCH_MATCHES } from "@stll/api-contract/search";

import { searchView } from "./model";
import { CaseLawApp } from "./view";
import type { CaseLawBridge } from "./view";

type Snapshot = ReturnType<CaseLawBridge["getSnapshot"]>;
const fakeBridge = (snapshot: Snapshot) => {
  const opened: string[] = [];
  let retries = 0;
  const bridge = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    supportsTools: () => false,
    connect: async () => {},
    call: async () => {},
    requestTool: async () => undefined,
    requestFullscreen: async () => {},
    requestInline: async () => {},
    retry: async () => {
      retries += 1;
    },
    openLink: async (url) => {
      opened.push(url);
    },
    detached: (promise) => {
      void promise;
    },
  } satisfies CaseLawBridge;
  return { bridge, opened, retries: () => retries };
};

const baseSnapshot = {
  context: { locale: "cs-CZ" },
  input: {},
  tool: "search_case_law",
} as const;

test("Czech host locale renders headings and retry action with the recoverable failure", () => {
  const host = fakeBridge({
    ...baseSnapshot,
    result: { status: "error", message: null },
  });
  const ui = render(<CaseLawApp bridge={host.bridge} />);
  expect(ui.getByRole("heading", { name: "Judikatura" })).toBeDefined();
  expect(ui.getByRole("alert").textContent).toContain(
    "Něco se pokazilo. Zkuste to znovu.",
  );
  fireEvent.click(ui.getByRole("button", { name: "Spustit znovu" }));
  expect(host.retries()).toBe(1);
});

test("invalid agent filter input displays a translated hint", () => {
  const host = fakeBridge({
    ...baseSnapshot,
    input: { country: "invalid" },
    result: {
      status: "ready",
      view: {
        type: "search",
        results: [],
        facets: null,
        nextCursor: null,
        searches: [],
      },
    },
  });
  const ui = render(<CaseLawApp bridge={host.bridge} />);
  expect(ui.getByRole("alert").textContent).toBe("Vyberte platný stát.");
});

test.each(["cs-CZ", "en", "ar"])(
  "agent-directed court and grammar notes never render in the %s app",
  (locale) => {
    const messages = [
      'Read court "NS" as "Nejvyšší soud". Pass court "Nejvyšší soud" to search the same way without this note.',
      "The search did not require these words, which are grammar rather than subject matter: za, vůči. Pass strict: true to require every word, or quote a phrase...",
    ];
    const host = fakeBridge({
      ...baseSnapshot,
      context: { locale },
      input: { country: "CZE", queries: ["náhrada škody"] },
      result: {
        status: "ready",
        view: {
          type: "search",
          results: [],
          facets: null,
          nextCursor: null,
          searches: messages.map((message) => ({
            warnings: [{ audience: "agent", message }],
          })),
        },
      },
    });
    const ui = render(<CaseLawApp bridge={host.bridge} />);
    expect(ui.getByRole("main")).toBeDefined();
    for (const message of messages) {
      expect(ui.container.textContent).not.toContain(message);
    }
    expect(ui.container.textContent).not.toContain("Pass strict: true");
    expect(ui.container.textContent).not.toContain('Read court "NS"');
  },
);

test("resolved decisions preserve citations and open the external link", () => {
  const host = fakeBridge({
    ...baseSnapshot,
    result: {
      status: "ready",
      view: {
        type: "resolve",
        status: "resolved",
        rows: [
          {
            type: "resolve",
            textState: null,
            snippet: null,
            decisionId: "decision-1",
            court: "Nejvyšší soud",
            courtAbbreviation: null,
            decisionDate: null,
            caseNumber: "25 Cdo 123/2024",
            ecli: "ECLI:CZ:NS:2024:25.CDO.123.2024.1",
            url: "https://stella.example/decision/1",
            source_url: undefined,
          },
        ],
      },
    },
  });
  const ui = render(<CaseLawApp bridge={host.bridge} />);
  fireEvent.click(ui.getByRole("button", { name: "25 Cdo 123/2024" }));
  expect(host.opened).toEqual(["https://stella.example/decision/1"]);
});

test("search dates expose localized labels and calendar controls", async () => {
  const host = fakeBridge({
    ...baseSnapshot,
    input: { country: "CZE", queries: ["náhrada škody"] },
    result: {
      status: "ready",
      view: {
        type: "search",
        results: [],
        facets: null,
        nextCursor: null,
        searches: [],
      },
    },
  });
  const ui = render(<CaseLawApp bridge={host.bridge} />);
  expect(ui.getByRole("button", { name: "Do Vybrat datum…" })).toBeDefined();
  fireEvent.click(ui.getByRole("button", { name: "Od Vybrat datum…" }));
  expect(await ui.findByRole("dialog", { name: "Výběr data" })).toBeDefined();
  expect(ui.getByRole("button", { name: "Předchozí měsíc" })).toBeDefined();
});

test("Arabic results render localized empty-state copy in the host direction", () => {
  const host = fakeBridge({
    ...baseSnapshot,
    context: { locale: "ar" },
    result: {
      status: "ready",
      view: {
        type: "resolve",
        status: "not_found",
        reason: "no_exact_identity",
      },
    },
  });
  const ui = render(<CaseLawApp bridge={host.bridge} />);
  expect(ui.getByRole("main").getAttribute("dir")).toBe("rtl");
  expect(ui.getByRole("heading", { name: "الاجتهاد القضائي" })).toBeDefined();
  expect(ui.getByRole("status").textContent).toBe(
    "لم يُعثر على حكم مطابق تمامًا. ابحث في الاجتهاد القضائي بدلًا من ذلك.",
  );
});

for (const { locale, label, direction } of [
  { locale: "en", label: "Partial match", direction: "ltr" },
  { locale: "ar", label: "تطابق جزئي", direction: "rtl" },
] as const) {
  test.each(DECISION_SEARCH_MATCHES)(
    `${locale} results disclose %s matching in the host direction`,
    (match) => {
      const host = fakeBridge({
        ...baseSnapshot,
        context: { locale },
        input: { country: "CZE", queries: ["náhrada škody"] },
        result: {
          status: "ready",
          view: searchView({
            ...APP_SEARCH_FIXTURE,
            results: APP_SEARCH_FIXTURE.results.map((row) => ({
              ...row,
              match,
            })),
          }),
        },
      });
      const ui = render(<CaseLawApp bridge={host.bridge} />);
      expect(ui.getByRole("main").getAttribute("dir")).toBe(direction);
      const labels = ui.queryAllByText(label);
      expect(labels).toHaveLength(
        match === "some_terms" ? APP_SEARCH_FIXTURE.results.length : 0,
      );
    },
  );
}

test("metadata-only search hits visibly distinguish summaries from decision text", () => {
  const host = fakeBridge({
    ...baseSnapshot,
    result: {
      status: "ready",
      view: searchView({
        ...APP_SEARCH_FIXTURE,
        results: APP_SEARCH_FIXTURE.results.map((row) => ({
          ...row,
          textAvailability: "metadata_only" as const,
        })),
      }),
    },
  });
  const ui = render(<CaseLawApp bridge={host.bridge} />);
  expect(ui.getByText("Rozhodnutí nemá text")).toBeDefined();
});

test.each([
  { status: CASE_LAW_TEXT_STATUS.STORED, label: null },
  {
    status: CASE_LAW_TEXT_STATUS.PUBLISHER_HAS_NO_TEXT,
    label: "No text published",
  },
  { status: CASE_LAW_TEXT_STATUS.FETCH_PENDING, label: "Text pending" },
  { status: CASE_LAW_TEXT_STATUS.FETCH_FAILED, label: "Text retrieval failed" },
  {
    status: CASE_LAW_TEXT_STATUS.METADATA_ONLY_BY_SOURCE,
    label: "Metadata-only source",
  },
] as const satisfies readonly {
  status: CaseLawTextStatus;
  label: string | null;
}[])(
  "search distinguishes $status from missing legacy text",
  ({ status, label }) => {
    const host = fakeBridge({
      ...baseSnapshot,
      context: { locale: "en" },
      input: { country: "CZE", queries: ["fixture"] },
      result: {
        status: "ready",
        view: searchView({
          ...APP_SEARCH_FIXTURE,
          results: APP_SEARCH_FIXTURE.results.map((row) => ({
            ...row,
            textState: status,
            textAvailability: "available" as const,
          })),
        }),
      },
    });
    const ui = render(<CaseLawApp bridge={host.bridge} />);
    expect(ui.queryByText("No decision text")).toBeNull();
    if (label !== null) {
      expect(ui.getByText(label)).toBeDefined();
    }
  },
);
