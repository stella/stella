import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import englishMessages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import { AI_COLUMN_RUN_REVEAL, aiColumnRunScope } from "./ai-column-run.logic";
import type { AiColumnRunReveal } from "./ai-column-run.logic";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });
const { cleanup, render, screen } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { resolveActionCapabilities } =
  await import("@/lib/organization/feature-access/action-capabilities.logic");
const { ActionCapabilitiesProvider } =
  await import("@/lib/organization/feature-access/capability-actions");
const { AiColumnRunButton } = await import("./ai-column-run-controls");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

const RUN_LABEL = "Run for 2 rows on this page";
const HEADER_NAME = "Parties to agreement";

type RenderHeaderOptions = {
  reveal: AiColumnRunReveal;
  disabled: boolean;
};

// The button sits in a column header the way the table renders it: a
// `group/table-head` header holding the column's name trigger and the Play.
const renderHeader = ({ reveal, disabled }: RenderHeaderOptions) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ActionCapabilitiesProvider
        value={resolveActionCapabilities({
          role: "member",
          ai: true,
          deepl: true,
          ocr: true,
          desktop: "current",
          settings: undefined,
        })}
      >
        <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
          <div className="group/table-head" role="columnheader">
            <button type="button">{HEADER_NAME}</button>
            <AiColumnRunButton
              disabled={disabled}
              onRun={() => undefined}
              reveal={reveal}
              scope={aiColumnRunScope({
                pageRowIds: ["a", "b"],
                selectedRowIds: [],
              })}
            />
          </div>
        </IntlProvider>
      </ActionCapabilitiesProvider>
    </QueryClientProvider>,
  );

const revealSlot = (button: HTMLElement) => {
  const slot = button.closest("[data-run-reveal]");
  if (!(slot instanceof HTMLElement)) {
    throw new TypeError("The run button renders outside its reveal slot");
  }
  return slot;
};

const classesOf = (element: HTMLElement) => [...element.classList];

describe("the column header Play", () => {
  test("hidden at rest, it stays in the tab order and focus or hover in the header reveals it", () => {
    for (const disabled of [false, true]) {
      renderHeader({ reveal: AI_COLUMN_RUN_REVEAL.onInteraction, disabled });
      const button = screen.getByRole("button", { name: RUN_LABEL });
      const slot = revealSlot(button);

      expect(button.tabIndex).toBe(0);
      expect(button.closest("[inert], [aria-hidden='true']")).toBeNull();
      button.focus();
      expect(document.activeElement).toBe(button);

      expect(classesOf(slot)).toEqual(
        expect.arrayContaining([
          "opacity-0",
          "group-focus-within/table-head:opacity-100",
          "group-hover/table-head:opacity-100",
          // Touch has no hover, so it never hides there.
          "pointer-coarse:opacity-100",
        ]),
      );
      cleanup();
    }
  });

  test("pinned, it is on screen without hover or focus", () => {
    renderHeader({ reveal: AI_COLUMN_RUN_REVEAL.pinned, disabled: false });
    const button = screen.getByRole("button", { name: RUN_LABEL });

    expect(classesOf(revealSlot(button))).not.toContain("opacity-0");
    expect(button.tabIndex).toBe(0);
  });

  test("it uses the quiet ghost treatment, never a filled square", () => {
    for (const reveal of Object.values(AI_COLUMN_RUN_REVEAL)) {
      renderHeader({ reveal, disabled: false });
      const button = screen.getByRole("button", { name: RUN_LABEL });

      expect(classesOf(button)).toContain("border-transparent");
      expect(classesOf(button)).not.toContain("bg-primary");
      cleanup();
    }
  });
});
