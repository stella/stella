import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, expect, spyOn, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

GlobalRegistrator.register();
const { act, cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { ReaderBreadcrumb } = await import("./reader-breadcrumb");
const { default: messages } = await import("@/i18n/langs/en.json");

afterEach(() => {
  cleanup();
});

const path = [
  "Část druhá",
  "Hlava I",
  "Oddíl A",
  "Díl 1",
  "§ 5 Žádost o poskytnutí přímé platby",
].map((title, index) => ({ anchorId: `heading-${index}`, title }));
const mount = (onJump: (id: string) => void) =>
  render(
    <IntlProvider locale="en" messages={messages}>
      <TooltipProvider>
        <ReaderBreadcrumb headings={path} onJump={onJump} path={path} />
      </TooltipProvider>
    </IntlProvider>,
  );

test("reader breadcrumb shows three heading levels and exposes hidden jump destinations on click", async () => {
  const jumps: string[] = [];
  mount((id) => {
    jumps.push(id);
  });
  expect(screen.queryByRole("button", { name: "Hlava I" })).toBeNull();
  expect(screen.getByRole("button", { name: "Část druhá" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Díl 1" })).toBeTruthy();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Show more" })),
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Hlava I" })),
  );
  expect(jumps).toEqual(["heading-1"]);
});

test("reader breadcrumb opens hidden levels on hover", async () => {
  mount(() => {});
  await act(async () =>
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Show more" })),
  );
  expect(screen.getByRole("button", { name: "Oddíl A" })).toBeTruthy();
});

test("reader breadcrumb jumps ancestors and opens Contents at the current provision", async () => {
  const positioned = spyOn(HTMLElement.prototype, "scrollIntoView");
  const jumps: string[] = [];
  mount((id) => {
    jumps.push(id);
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Část druhá" })),
  );
  expect(jumps).toEqual(["heading-0"]);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: /Contents: § 5/u })),
  );
  expect(jumps).toEqual(["heading-0"]);
  const currentTitle = path.at(-1)?.title;
  if (currentTitle === undefined) {
    throw new Error("Current heading is missing from fixture");
  }
  const current = screen.getByRole("button", { name: currentTitle });
  expect(current.getAttribute("aria-current")).toBe("location");
  expect(positioned.mock.contexts.includes(current)).toBe(true);
  positioned.mockRestore();
  await act(async () => fireEvent.click(current));
  expect(jumps).toEqual(["heading-0", "heading-4"]);
});

test("reader breadcrumb follows the visible heading on scroll with throttled announcements", async () => {
  const { observeReaderBreadcrumb } =
    await import("./reader-breadcrumb-scroll");
  const viewport = document.createElement("div");
  const content = document.createElement("article");
  viewport.append(content);
  document.body.append(viewport);
  for (const [index, { anchorId }] of path.entries()) {
    const heading = document.createElement("h2");
    heading.dataset["anchor"] = anchorId;
    heading.getBoundingClientRect = () =>
      new DOMRect(0, index * 100 - viewport.scrollTop, 200, 24);
    content.append(heading);
  }
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
  const changes: (string | null)[] = [];
  const stop = observeReaderBreadcrumb({
    viewport,
    content,
    anchors: path.map(({ anchorId }) => anchorId),
    onAnchorChange: (id) => {
      changes.push(id);
    },
  });
  expect(changes).toEqual(["heading-0"]);
  viewport.scrollTop = 250;
  viewport.dispatchEvent(new Event("scroll"));
  viewport.scrollTop = 350;
  viewport.dispatchEvent(new Event("scroll"));
  expect(changes).toEqual(["heading-0"]);
  await sleep(220);
  expect(changes).toEqual(["heading-0", "heading-4"]);
  stop();
  viewport.scrollTop = 150;
  viewport.dispatchEvent(new Event("scroll"));
  await sleep(220);
  expect(changes).toEqual(["heading-0", "heading-4"]);
  viewport.remove();
});

test("reader breadcrumb uses translated Arabic chrome and isolates source titles", async () => {
  const { default: arabic } = await import("@/i18n/langs/ar.json");
  render(
    <IntlProvider locale="ar" messages={arabic}>
      <TooltipProvider>
        <div dir="rtl">
          <ReaderBreadcrumb headings={path} onJump={() => {}} path={path} />
        </div>
      </TooltipProvider>
    </IntlProvider>,
  );
  expect(
    screen.getByRole("navigation", { name: arabic.statutes.outline }),
  ).toBeTruthy();
  const more = screen.getByRole("button", { name: arabic.common.showMore });
  await act(async () => fireEvent.click(more));
  expect(
    screen.getByRole("button", { name: "Hlava I" }).querySelector("bdi")
      ?.textContent,
  ).toBe("Hlava I");
});

test("reader breadcrumb allocates narrow width to the current number before outer titles", async () => {
  const originalObserver = globalThis.ResizeObserver;
  const callbacks: (() => void)[] = [];
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(() => callback([], this));
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  try {
    mount(() => {});
    const navigation = screen.getByRole("navigation");
    Object.defineProperty(navigation, "clientWidth", {
      value: 218,
      configurable: true,
    });
    for (const label of navigation.querySelectorAll(
      "[data-breadcrumb-measure]",
    )) {
      label.getBoundingClientRect = () => new DOMRect(0, 0, 84, 16);
    }
    const number = navigation.querySelector("[data-breadcrumb-number-measure]");
    if (number === null) {
      throw new Error("Number measurement not rendered");
    }
    number.getBoundingClientRect = () => new DOMRect(0, 0, 28, 16);
    await act(async () => {
      for (const resize of callbacks) {
        resize();
      }
    });
    expect(screen.getByRole("button", { name: "Část druhá" }).style.width).toBe(
      "16px",
    );
    expect(screen.getByRole("button", { name: "Díl 1" }).style.width).toBe(
      "16px",
    );
    const current = screen.getByRole("button", { name: /Contents: § 5/u });
    expect(current.style.width).toBe("94px");
    expect(current.querySelector("bdi")?.textContent).toBe("§ 5");
    expect(current.querySelector("bdi")?.classList.contains("shrink-0")).toBe(
      true,
    );
    expect(navigation.querySelector('[aria-live="polite"]')?.textContent).toBe(
      path.map(({ title }) => title).join(" › "),
    );
    Object.defineProperty(navigation, "clientWidth", {
      value: 60,
      configurable: true,
    });
    await act(async () => {
      for (const resize of callbacks) {
        resize();
      }
    });
    expect(screen.queryByRole("button", { name: "Část druhá" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Díl 1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Contents: § 5/u }).style.width,
    ).toBe("60px");
  } finally {
    cleanup();
    globalThis.ResizeObserver = originalObserver;
  }
});

test("Contents remains reachable while introductory paragraphs precede the first visible heading", async () => {
  const { LegalReaderBreadcrumb } = await import("./legal-reader-breadcrumb");
  const viewport = document.createElement("div");
  const content = document.createElement("article");
  const intro = document.createElement("p");
  intro.textContent = "Introductory wording";
  const heading = document.createElement("h2");
  heading.dataset["anchor"] = "first";
  heading.getBoundingClientRect = () => new DOMRect(0, 200, 200, 24);
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
  content.append(intro, heading);
  viewport.append(content);
  document.body.append(viewport);
  try {
    render(
      <IntlProvider locale="en" messages={messages}>
        <TooltipProvider>
          <LegalReaderBreadcrumb
            blocks={[
              {
                type: "heading",
                id: "first",
                anchorId: "first",
                level: 1,
                plainText: "First heading",
                inlines: [],
              },
            ]}
            viewportRef={{ current: viewport }}
            contentRef={{ current: content }}
          />
        </TooltipProvider>
      </IntlProvider>,
    );
    expect(
      screen.getByRole("navigation").querySelector('[aria-live="polite"]')
        ?.textContent,
    ).toBe("");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Contents" })),
    );
    expect(screen.getByRole("button", { name: "First heading" })).toBeTruthy();
  } finally {
    cleanup();
    viewport.remove();
  }
});
