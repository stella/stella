import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const messages = (await import("@/i18n/langs/en.json")).default;
const { stateHue } = await import("@/features/avt/state-chip");
const { ViewLayoutPreview } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/view/view-layout-preview");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

const renderPreview = (kind: "avt" | "kanban" | "table") =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en-GB" timeZone="UTC">
          <ViewLayoutPreview kind={kind} workspaceId="preview-workspace" />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

test("the kanban preview plays the card's move through the shared animated preview", () => {
  const view = renderPreview("kanban");
  const motion = view.container.querySelector<HTMLElement>(
    '[data-slot="animated-preview-motion"]',
  );
  const frame = motion?.querySelector<HTMLElement>(
    '[data-slot="animated-preview"]',
  );

  if (!frame) {
    throw new Error("the kanban preview has no animated frame");
  }
  expect(frame.dataset["playback"]).toBe("once");
  const stages = [...frame.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child.dataset["slot"] === "animated-preview-stage",
  );
  // The card in progress goes out as the same card, done, comes in.
  expect(
    stages.map((stage) => ({
      index: stage.dataset["stageIndex"],
      incoming: stage.dataset["incoming"] !== undefined,
      outgoing: stage.dataset["outgoing"] !== undefined,
      title: stage.textContent.includes("Review contract"),
    })),
  ).toEqual([
    { index: "0", incoming: false, outgoing: true, title: true },
    { index: "1", incoming: true, outgoing: false, title: true },
  ]);
});

test("a still layout preview carries no animation", () => {
  const view = renderPreview("table");

  expect(
    view.container.querySelector(
      '[data-slot="animated-preview"], [data-slot="animated-preview-motion"]',
    ),
  ).toBeNull();
  expect(view.container.textContent).toContain("Service agreement");
});

test("the AVT preview links each claim to its fact in turn, in the verdict's hue", () => {
  const view = renderPreview("avt");
  const frames = [
    ...view.container.querySelectorAll<HTMLElement>(
      '[data-slot="animated-preview"]',
    ),
  ];

  expect(
    frames.map((frame) => ({
      stagger: frame.style.getPropertyValue("--animated-preview-stagger"),
      mark: frame.querySelector("line")?.getAttribute("stroke"),
      links: frame.querySelectorAll("path").length,
    })),
  ).toEqual([
    { stagger: "0", mark: stateHue("supported"), links: 1 },
    { stagger: "3", mark: stateHue("contradicted"), links: 1 },
    { stagger: "6", mark: stateHue("tension"), links: 1 },
    // No coverage: the claim keeps its mark and finds no fact.
    { stagger: "9", mark: stateHue("nocover"), links: 0 },
  ]);
});
