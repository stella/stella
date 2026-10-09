import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import arabic from "@/i18n/langs/ar.json";
import english from "@/i18n/langs/en.json";

import type { AnalysisState } from "./use-decision-analysis";

GlobalRegistrator.register({ url: "https://app.example.test/law" });
const { act } = await import("react");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { DecisionInspectorOutline, scrollDecisionInspectorToAnchor } =
  await import("./decision-inspector-outline");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await act(async () => {
    await sleep(50);
  });
  await GlobalRegistrator.unregister();
});

const parentLabel = "Reasons";
const childLabel = "Conclusion";
const done = {
  status: "done",
  analysis: {
    version: 2,
    generatedAt: "2026-10-05T10:00:00Z",
    model: "fixture-model",
    inputFingerprint: "fixture-document",
    tree: [
      {
        id: "reasons",
        label: parentLabel,
        category: "reasoning",
        startAnchorId: "section-start",
        endAnchorId: "section-end",
        annotations: [
          {
            id: "annotation",
            summary: "Fixture summary",
            textSnippet: "Fixture text",
            startAnchorId: "annotation-start",
            endAnchorId: "annotation-end",
          },
        ],
        children: [
          {
            id: "conclusion",
            label: childLabel,
            category: "holding",
            startAnchorId: "child-start",
            endAnchorId: "child-end",
            annotations: [],
            children: [],
          },
        ],
      },
    ],
  },
} satisfies AnalysisState;

const states = {
  idle: { status: "idle" },
  generating: { status: "generating", tree: done.analysis.tree },
  error: { status: "error" },
  done,
} satisfies Record<AnalysisState["status"], AnalysisState>;

for (const [locale, messages] of Object.entries({ en: english, ar: arabic })) {
  test(`outline navigates annotation and fallback anchors and closes in ${locale}`, async () => {
    const testDocument = render(null).container.ownerDocument;
    const anchors: string[] = [];
    const scrolls: (number | ScrollToOptions | undefined)[] = [];
    const viewport = testDocument.createElement("div");
    const content = testDocument.createElement("article");
    const parentAnchor = testDocument.createElement("p");
    const childAnchor = testDocument.createElement("p");
    parentAnchor.dataset["anchor"] = "annotation-start";
    childAnchor.dataset["anchor"] = "child-start";
    content.append(parentAnchor, childAnchor);
    viewport.append(content);
    viewport.scrollTop = 37;
    viewport.getBoundingClientRect = () => new DOMRect(0, 120, 320, 500);
    parentAnchor.getBoundingClientRect = () => new DOMRect(0, 460, 320, 30);
    childAnchor.getBoundingClientRect = () => new DOMRect(0, 600, 320, 30);
    viewport.scrollTo = (options) => {
      scrolls.push(options);
    };
    const view = render(
      <IntlProvider locale={locale} messages={messages} timeZone="UTC">
        <div dir={locale === "ar" ? "rtl" : "ltr"}>
          <DecisionInspectorOutline
            state={done}
            available
            onAnchorClick={(id) => {
              anchors.push(id);
              scrollDecisionInspectorToAnchor({
                content,
                viewport,
                anchorId: id,
              });
            }}
          />
        </div>
      </IntlProvider>,
    );
    const trigger = view.getByRole("button", {
      name: messages.statutes.outline,
    });
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(
        view.getByRole("navigation", { name: messages.statutes.outline }),
      ).toBeDefined(),
    );
    expect(
      view
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-level")),
    ).toEqual(["1", "2"]);
    fireEvent.click(view.getByRole("button", { name: parentLabel }));
    expect(anchors).toEqual(["annotation-start"]);
    expect(scrolls).toEqual([{ top: 377 }]);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(trigger.getAttribute("aria-expanded")).toBe("true"),
    );
    fireEvent.click(view.getByRole("button", { name: childLabel }));
    expect(anchors).toEqual(["annotation-start", "child-start"]);
    expect(scrolls).toEqual([{ top: 377 }, { top: 517 }]);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
}

test("unavailable analysis states and empty outlines show no control or error", () => {
  const cases = [
    ...Object.values(states).map((state) => ({ state, available: false })),
    { state: states.idle, available: true },
    { state: states.generating, available: true },
    { state: states.error, available: true },
    {
      state: { status: "done", analysis: { ...done.analysis, tree: [] } },
      available: true,
    },
  ] satisfies { state: AnalysisState; available: boolean }[];
  for (const props of cases) {
    const view = render(
      <IntlProvider locale="en" messages={english} timeZone="UTC">
        <DecisionInspectorOutline {...props} onAnchorClick={() => undefined} />
      </IntlProvider>,
    );
    expect(view.container.childElementCount).toBe(0);
    expect(view.queryByRole("alert")).toBeNull();
    view.unmount();
  }
});

test("outline scrolling ignores missing anchors and missing viewport or content", () => {
  const testDocument = render(null).container.ownerDocument;
  const content = testDocument.createElement("article");
  const viewport = testDocument.createElement("div");
  const externalAnchor = testDocument.createElement("p");
  externalAnchor.dataset["anchor"] = "outside-reader";
  testDocument.body.append(externalAnchor);
  const scrolls: (number | ScrollToOptions | undefined)[] = [];
  viewport.scrollTo = (options) => {
    scrolls.push(options);
  };
  for (const options of [
    { content, viewport, anchorId: "outside-reader" },
    { content: null, viewport, anchorId: "outside-reader" },
    { content, viewport: null, anchorId: "outside-reader" },
  ]) {
    scrollDecisionInspectorToAnchor(options);
  }
  expect(scrolls).toEqual([]);
  externalAnchor.remove();
});
