import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

import { READER_BREADCRUMB_CLEARANCE } from "@stll/decision-reader/reader-landing";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import type { FlatAnalysisHeading } from "./types";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { CurrentSection } = await import("./current-section");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

const CONTAINER_TOP = 100;

const heading = (id: string): FlatAnalysisHeading => ({
  id,
  label: `Section ${id}`,
  category: "reasoning",
  startAnchorId: id,
  endAnchorId: id,
  annotations: [],
  children: [],
  depth: 0,
});

/** The notes column's control over two headings at the given offsets. */
const mount = (offsets: { first: number; second: number }, scrollTop = 0) => {
  const { container } = render(<div />);
  container.getBoundingClientRect = () =>
    new DOMRect(0, CONTAINER_TOP, 400, 600);
  const scrollTo = mock(() => undefined);
  container.scrollTo = scrollTo;
  Object.defineProperty(container, "scrollTop", { value: scrollTop });
  for (const [id, offset] of Object.entries(offsets)) {
    const block = container.ownerDocument.createElement("p");
    block.id = id;
    block.getBoundingClientRect = () =>
      new DOMRect(0, CONTAINER_TOP + offset, 400, 24);
    container.append(block);
  }
  const view = render(
    <IntlProvider locale="en" messages={messages}>
      <CurrentSection
        anchorById={
          new Map([
            ["first", "first"],
            ["second", "second"],
          ])
        }
        headings={[heading("first"), heading("second")]}
        scrollContainerRef={{ current: container }}
      />
    </IntlProvider>,
  );
  return {
    control: view.getByRole("button", { hidden: true }),
    scrollTo,
  };
};

describe("the section held above the notes", () => {
  test("a heading a jump just landed is the section the reader is on", () => {
    const { control } = mount({
      first: -400,
      second: READER_BREADCRUMB_CLEARANCE,
    });
    expect(control.textContent).toContain("Section second");
  });

  test("clicking the section lands its heading below the controls bar", () => {
    const { control, scrollTo } = mount(
      { first: -400, second: READER_BREADCRUMB_CLEARANCE },
      300,
    );
    fireEvent.click(control);
    expect(scrollTo).toHaveBeenCalledWith({ top: 300, behavior: "instant" });
    expect(control.textContent).toContain("Section second");
  });

  test("a heading still further down the text is not current yet", () => {
    const { control } = mount({
      first: -400,
      second: READER_BREADCRUMB_CLEARANCE + 100,
    });
    expect(control.textContent).toContain("Section first");
  });

  test("nothing shows until a heading has reached the bar", () => {
    const { control } = mount({
      first: READER_BREADCRUMB_CLEARANCE + 100,
      second: READER_BREADCRUMB_CLEARANCE + 500,
    });
    expect(control.hasAttribute("disabled")).toBe(true);
  });
});
