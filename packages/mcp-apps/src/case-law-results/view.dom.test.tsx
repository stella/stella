import { fireEvent, render } from "@testing-library/react";
import { expect, test } from "bun:test";

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
  expect(ui.getByRole("alert").textContent).toContain("Chyba");
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
        nextStep: undefined,
      },
    },
  });
  const ui = render(<CaseLawApp bridge={host.bridge} />);
  expect(ui.getByRole("alert").textContent).toBe("Vyberte platný stát.");
});

test("lookup results preserve citations and use the external link when tools are unavailable", () => {
  const host = fakeBridge({
    ...baseSnapshot,
    result: {
      status: "ready",
      view: {
        type: "lookup",
        notices: [],
        rows: [
          {
            type: "lookup",
            snippet: null,
            decisionId: "decision-1",
            court: "Nejvyšší soud",
            courtAbbreviation: null,
            decisionDate: null,
            caseNumber: "25 Cdo 123/2024",
            ecli: "ECLI:CZ:NS:2024:25.CDO.123.2024.1",
            appUrl: "https://stella.example/decision/1",
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
        nextStep: undefined,
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
      view: { type: "lookup", notices: [], rows: [] },
    },
  });
  const ui = render(<CaseLawApp bridge={host.bridge} />);
  expect(ui.getByRole("main").getAttribute("dir")).toBe("rtl");
  expect(ui.getByRole("heading", { name: "الاجتهاد القضائي" })).toBeDefined();
  expect(ui.getByRole("status").textContent).toBe("لا توجد نتائج");
});
