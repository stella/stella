import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, expect, spyOn, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";
import type { HeadingBlock, HeadingLevel } from "@stll/legal-ast/document-ast";

GlobalRegistrator.register();
const { act, cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { ReaderBreadcrumb } = await import("./reader-breadcrumb");
const { default: messages } = await import("@/i18n/langs/en.json");
const { analysisReaderBreadcrumbPaths } =
  await import("@/features/case-law/components/case-decision-inspector-view.logic");

afterEach(() => {
  cleanup();
});

const path = (
  [
    { title: "Část druhá", level: 1 },
    { title: "Hlava I", level: 2 },
    { title: "Oddíl A", level: 3 },
    { title: "Díl 1", level: 4 },
    { title: "§ 5 Žádost o poskytnutí přímé platby", level: 5 },
  ] satisfies { title: string; level: HeadingLevel }[]
).map(({ title, level }, index) => ({
  anchorId: `heading-${index}`,
  title,
  level,
}));
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

test("hidden levels stay open when the ellipsis is clicked after hover", async () => {
  mount(() => {});
  const trigger = screen.getByRole("button", { name: "Show more" });
  await act(async () => fireEvent.mouseEnter(trigger));
  expect(screen.getByRole("button", { name: "Hlava I" })).toBeTruthy();
  await act(async () => fireEvent.click(trigger));
  expect(screen.queryByRole("button", { name: "Hlava I" })).not.toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
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

test("paragraph-only decisions keep completed analysis headings in Contents and navigate to them", async () => {
  const { LegalReaderBreadcrumb } = await import("./legal-reader-breadcrumb");
  const viewport = document.createElement("div");
  const content = document.createElement("article");
  const paragraph = document.createElement("p");
  paragraph.dataset["anchor"] = "paragraph-1";
  paragraph.getBoundingClientRect = () =>
    new DOMRect(0, 100 - viewport.scrollTop, 200, 24);
  content.append(paragraph);
  const childParagraph = document.createElement("p");
  childParagraph.dataset["anchor"] = "paragraph-2";
  childParagraph.getBoundingClientRect = () =>
    new DOMRect(0, 200 - viewport.scrollTop, 200, 24);
  content.append(childParagraph);
  viewport.append(content);
  document.body.append(viewport);
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
  Object.defineProperties(viewport, {
    clientHeight: { value: 300 },
    scrollHeight: { value: 1000 },
  });
  viewport.scrollTop = 200;
  viewport.scrollTo = (options?: ScrollToOptions | number) => {
    if (options === undefined || typeof options === "number") {
      throw new Error("Expected breadcrumb scroll options");
    }
    viewport.scrollTop = Math.round(options.top ?? 0);
  };
  const completedAnalysisTree = [
    {
      id: "analysis-1",
      label: "Court reasoning",
      category: "reasoning",
      startAnchorId: "paragraph-1",
      endAnchorId: "paragraph-1",
      annotations: [],
      children: [
        {
          id: "analysis-2",
          label: "Outcome",
          category: "holding",
          startAnchorId: "paragraph-2",
          endAnchorId: "paragraph-2",
          annotations: [],
          children: [],
        },
      ],
    },
  ];
  try {
    render(
      <IntlProvider locale="en" messages={messages}>
        <TooltipProvider>
          <LegalReaderBreadcrumb
            blocks={[
              {
                type: "paragraph",
                id: "paragraph-1",
                anchorId: "paragraph-1",
                plainText: "The court gives its reasons.",
                inlines: [
                  { type: "text", text: "The court gives its reasons." },
                ],
              },
              {
                type: "paragraph",
                id: "paragraph-2",
                anchorId: "paragraph-2",
                plainText: "The appeal is dismissed.",
                inlines: [{ type: "text", text: "The appeal is dismissed." }],
              },
            ]}
            fallback={analysisReaderBreadcrumbPaths(completedAnalysisTree)}
            viewport={viewport}
            content={content}
          />
        </TooltipProvider>
      </IntlProvider>,
    );
    await act(async () => {
      await sleep(0);
    });
    expect(
      screen.getByRole("button", { name: "Contents: Outcome" }),
    ).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Court reasoning" })),
    );
    expect(viewport.scrollTop).toBe(36);
  } finally {
    viewport.remove();
  }
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
  Object.defineProperties(viewport, {
    clientHeight: { value: 300 },
    scrollHeight: { value: 1000 },
  });
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

test("reader breadcrumb tracks headings in document order when anchors arrive in tree order", async () => {
  const { observeReaderBreadcrumb } =
    await import("./reader-breadcrumb-scroll");
  const viewport = document.createElement("div");
  const content = document.createElement("article");
  viewport.append(content);
  document.body.append(viewport);
  for (const [anchorId, top] of [
    ["paragraph-2", 100],
    ["paragraph-10", 400],
  ] as const) {
    const paragraph = document.createElement("p");
    paragraph.dataset["anchor"] = anchorId;
    paragraph.getBoundingClientRect = () =>
      new DOMRect(0, top - viewport.scrollTop, 200, 24);
    content.append(paragraph);
  }
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
  Object.defineProperties(viewport, {
    clientHeight: { value: 300 },
    scrollHeight: { value: 2000 },
  });
  const changes: (string | null)[] = [];
  // An analysis parent whose display anchor follows its child's anchor.
  const stop = observeReaderBreadcrumb({
    viewport,
    content,
    anchors: ["paragraph-10", "paragraph-2"],
    onAnchorChange: (id) => {
      changes.push(id);
    },
  });
  try {
    viewport.scrollTop = 400;
    viewport.dispatchEvent(new Event("scroll"));
    await sleep(220);
    expect(changes).toEqual([null, "paragraph-10"]);
  } finally {
    stop();
    viewport.remove();
  }
});

for (const jump of ["contents", "ancestor"]) {
  for (const scrollHeight of jump === "contents" ? [1000, 500] : [1000]) {
    for (const fraction of [0.0625, 0.4375, 0.9375]) {
      test(`${jump} jumps activate their selected heading with fractional geometry ${fraction} and document height ${scrollHeight}`, async () => {
        const { LegalReaderBreadcrumb } =
          await import("./legal-reader-breadcrumb");
        const viewport = document.createElement("div");
        const content = document.createElement("article");
        const viewportTop = 17.375;
        viewport.scrollTop = jump === "ancestor" ? 400 : 0;
        viewport.getBoundingClientRect = () =>
          new DOMRect(0, viewportTop, 400, 300);
        Object.defineProperties(viewport, {
          clientHeight: { value: 300 },
          scrollHeight: { value: scrollHeight },
        });
        // Model the browser's integer scroll position without rounding the headings.
        viewport.scrollTo = (options?: ScrollToOptions | number) => {
          if (options === undefined || typeof options === "number") {
            throw new Error("Expected breadcrumb scroll options");
          }
          viewport.scrollTop = Math.max(
            0,
            Math.min(
              viewport.scrollHeight - viewport.clientHeight,
              Math.round(options.top ?? 0),
            ),
          );
          viewport.dispatchEvent(new Event("scroll"));
        };
        for (const [index, { anchorId }] of path.entries()) {
          const heading = document.createElement("h2");
          heading.dataset["anchor"] = anchorId;
          heading.getBoundingClientRect = () =>
            new DOMRect(
              0,
              viewportTop + index * 100 + fraction - viewport.scrollTop,
              200,
              24,
            );
          content.append(heading);
        }
        viewport.append(content);
        document.body.append(viewport);
        try {
          render(
            <IntlProvider locale="en" messages={messages}>
              <TooltipProvider>
                <LegalReaderBreadcrumb
                  blocks={path.map(
                    ({ anchorId, title, level }) =>
                      ({
                        type: "heading",
                        id: anchorId,
                        anchorId,
                        level,
                        plainText: title,
                        inlines: [{ type: "text", text: title }],
                      }) satisfies HeadingBlock,
                  )}
                  viewport={viewport}
                  content={content}
                />
              </TooltipProvider>
            </IntlProvider>,
          );
          const target = path.at(jump === "ancestor" ? 3 : 4);
          if (target === undefined) {
            throw new Error("Jump target is missing from fixture");
          }
          if (jump === "contents") {
            await act(async () =>
              fireEvent.click(
                screen.getByRole("button", { name: /^Contents:/u }),
              ),
            );
          }
          await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: target.title }));
            await sleep(220);
          });
          expect(
            screen.getByRole("button", {
              name: `Contents: ${target.title}`,
            }),
          ).toBeTruthy();
        } finally {
          cleanup();
          viewport.remove();
        }
      });
    }
  }
}

test("plain scrolling selects the last visible heading at maximum scroll", async () => {
  const { observeReaderBreadcrumb } =
    await import("./reader-breadcrumb-scroll");
  const viewport = document.createElement("div");
  const content = document.createElement("article");
  viewport.getBoundingClientRect = () => new DOMRect(0, 17.375, 400, 300);
  Object.defineProperties(viewport, {
    clientHeight: { value: 300 },
    scrollHeight: { value: 500 },
  });
  for (const [index, { anchorId }] of path.entries()) {
    const heading = document.createElement("h2");
    heading.dataset["anchor"] = anchorId;
    heading.getBoundingClientRect = () =>
      new DOMRect(
        0,
        17.375 + index * 100 + 0.4375 - viewport.scrollTop,
        200,
        24,
      );
    content.append(heading);
  }
  const changes: (string | null)[] = [];
  const stop = observeReaderBreadcrumb({
    viewport,
    content,
    anchors: path.map(({ anchorId }) => anchorId),
    onAnchorChange: (id) => {
      changes.push(id);
    },
  });
  try {
    expect(changes).toEqual(["heading-0"]);
    viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
    viewport.dispatchEvent(new Event("scroll"));
    await sleep(220);
    expect(changes).toEqual(["heading-0", "heading-4"]);
  } finally {
    stop();
  }
});

test("viewport-only resizing updates the breadcrumb when the document fits", async () => {
  const { observeReaderBreadcrumb } =
    await import("./reader-breadcrumb-scroll");
  const originalObserver = globalThis.ResizeObserver;
  const resizeCallbacks = new Map<Element, () => void>();
  globalThis.ResizeObserver = class {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(element: Element) {
      resizeCallbacks.set(element, () => this.callback([], this));
    }
    unobserve(element: Element) {
      resizeCallbacks.delete(element);
    }
    disconnect() {
      resizeCallbacks.clear();
    }
  };
  try {
    const viewport = document.createElement("div");
    const content = document.createElement("article");
    let height = 300;
    viewport.getBoundingClientRect = () => new DOMRect(0, 17.375, 400, height);
    Object.defineProperties(viewport, {
      clientHeight: { get: () => height },
      scrollHeight: { value: 500 },
    });
    for (const [index, { anchorId }] of path.entries()) {
      const heading = document.createElement("h2");
      heading.dataset["anchor"] = anchorId;
      heading.getBoundingClientRect = () =>
        new DOMRect(0, 17.375 + index * 100, 200, 24);
      content.append(heading);
    }
    const changes: (string | null)[] = [];
    const stop = observeReaderBreadcrumb({
      viewport,
      content,
      anchors: path.map(({ anchorId }) => anchorId),
      onAnchorChange: (id) => {
        changes.push(id);
      },
    });
    try {
      expect(changes).toEqual(["heading-0"]);
      height = 500;
      resizeCallbacks.get(viewport)?.();
      await sleep(220);
      expect(changes).toEqual(["heading-0", "heading-4"]);
      expect(viewport.scrollTop).toBe(0);
    } finally {
      stop();
    }
  } finally {
    globalThis.ResizeObserver = originalObserver;
  }
});

test("the breadcrumb rebinds when the reader DOM is replaced", async () => {
  const { useReaderElement } = await import("./use-reader-element");
  const { LegalReaderBreadcrumb } = await import("./legal-reader-breadcrumb");
  const blocks = [
    {
      type: "heading",
      id: "first",
      anchorId: "first",
      level: 1,
      plainText: "First",
      inlines: [],
    },
    {
      type: "heading",
      id: "last",
      anchorId: "last",
      level: 1,
      plainText: "Last",
      inlines: [],
    },
  ] satisfies HeadingBlock[];
  const ReaderHarness = ({ generation }: { generation: number }) => {
    const { element: viewport, attach: attachViewport } =
      useReaderElement<HTMLDivElement>();
    const { element: content, attach: attachContent } =
      useReaderElement<HTMLElement>();
    return (
      <IntlProvider locale="en" messages={messages}>
        <TooltipProvider>
          <div key={generation} data-reader-viewport="" ref={attachViewport}>
            <article ref={attachContent}>
              {blocks.map(({ anchorId, plainText }) => (
                <h2 key={anchorId} data-anchor={anchorId}>
                  {plainText}
                </h2>
              ))}
            </article>
          </div>
          <LegalReaderBreadcrumb
            blocks={blocks}
            content={content}
            viewport={viewport}
          />
        </TooltipProvider>
      </IntlProvider>
    );
  };
  const scrollReader = async (scrollTop: number) => {
    const viewport = document.querySelector<HTMLElement>(
      "[data-reader-viewport]",
    );
    if (viewport === null) {
      throw new Error("Reader viewport is missing");
    }
    Object.defineProperties(viewport, {
      clientHeight: { value: 300 },
      scrollHeight: { value: 1000 },
    });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
    for (const [index, heading] of viewport.querySelectorAll("h2").entries()) {
      heading.getBoundingClientRect = () =>
        new DOMRect(0, 200 + index * 200 - viewport.scrollTop, 200, 24);
    }
    await act(async () => {
      viewport.scrollTop = scrollTop;
      viewport.dispatchEvent(new Event("scroll"));
      await sleep(220);
    });
    return viewport;
  };
  const { rerender } = render(<ReaderHarness generation={0} />);
  const oldViewport = await scrollReader(200);
  expect(screen.getByRole("button", { name: "Contents: First" })).toBeTruthy();
  rerender(<ReaderHarness generation={1} />);
  const nextViewport = await scrollReader(400);
  expect(oldViewport.isConnected).toBe(false);
  expect(nextViewport).not.toBe(oldViewport);
  expect(screen.getByRole("button", { name: "Contents: Last" })).toBeTruthy();
  await act(async () => {
    oldViewport.dispatchEvent(new Event("scroll"));
    await sleep(220);
  });
  expect(screen.getByRole("button", { name: "Contents: Last" })).toBeTruthy();
});

test("Contents consumes Escape and restores focus to its trigger", async () => {
  let outerEscapes = 0;
  const onOuterKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      outerEscapes += 1;
    }
  };
  window.addEventListener("keydown", onOuterKeyDown);
  try {
    mount(() => {});
    const trigger = screen.getByRole("button", { name: /^Contents:/u });
    await act(async () => fireEvent.click(trigger));
    const popup = screen.getByRole("dialog");
    await act(async () => {
      popup.focus();
      fireEvent.keyDown(popup, { key: "Escape" });
      await sleep(20);
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(outerEscapes).toBe(0);
  } finally {
    window.removeEventListener("keydown", onOuterKeyDown);
  }
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
  Object.defineProperties(viewport, {
    clientHeight: { value: 300 },
    scrollHeight: { value: 1000 },
  });
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
            viewport={viewport}
            content={content}
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
