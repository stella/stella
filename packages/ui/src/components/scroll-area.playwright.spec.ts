import { expect, type Page, test } from "@playwright/test";

const fixturePath = "/src/components/fixtures/scroll-area.fixture.html";

test.use({
  viewport: { width: 1440, height: 900 },
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
});

/** Sub-pixel rounding is not overflow. */
const TOLERANCE_PX = 1;

type CaseGeometry = {
  /** Bottom edge of the box that bounds the case: the card, else the root. */
  boundBottom: number;
  rootHeight: number;
  viewportBottom: number;
  viewportClientHeight: number;
  viewportScrollHeight: number;
  /** Whether a click at the footer button's centre lands on the button. */
  footerHit: boolean | null;
  footerTop: number | null;
};

const openFixture = async (page: Page) => {
  await page.goto(fixturePath);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["scrollAreaReady"] ?? "",
        ),
    )
    .toBe("true");
};

const measure = async (page: Page, name: string): Promise<CaseGeometry> =>
  await page.locator(`[data-case="${name}"]`).evaluate((frame) => {
    const viewport = frame.querySelector('[data-slot="scroll-area-viewport"]');
    const root = viewport?.parentElement;
    if (!(root instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
      throw new Error("scroll area fixture case is missing its scroll area");
    }
    const footer = frame.querySelector('[data-slot="case-footer"]');
    const button = footer?.querySelector("button") ?? null;
    const buttonBox = button?.getBoundingClientRect() ?? null;
    const hit =
      buttonBox === null
        ? null
        : document.elementFromPoint(
            buttonBox.left + buttonBox.width / 2,
            buttonBox.top + buttonBox.height / 2,
          );
    const bound = footer?.parentElement ?? root;
    return {
      boundBottom: bound.getBoundingClientRect().bottom,
      rootHeight: root.getBoundingClientRect().height,
      viewportBottom: viewport.getBoundingClientRect().bottom,
      viewportClientHeight: viewport.clientHeight,
      viewportScrollHeight: viewport.scrollHeight,
      footerHit: button === null ? null : hit !== null && button.contains(hit),
      footerTop: footer?.getBoundingClientRect().top ?? null,
    };
  });

const scrollsToLastLine = async (page: Page, name: string) => {
  const frame = page.locator(`[data-case="${name}"]`);
  const viewport = frame.locator('[data-slot="scroll-area-viewport"]');
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const last = frame.locator("[data-line]").last();
  const [lastBox, viewportBox] = await Promise.all([
    last.boundingBox(),
    viewport.boundingBox(),
  ]);
  expect(lastBox, `${name}: last line box`).not.toBeNull();
  expect(viewportBox, `${name}: viewport box`).not.toBeNull();
  if (lastBox === null || viewportBox === null) {
    return;
  }
  expect(
    lastBox.y + lastBox.height,
    `${name}: last line scrolls into the viewport`,
  ).toBeLessThanOrEqual(viewportBox.y + viewportBox.height + TOLERANCE_PX);
};

test.beforeEach(async ({ page }) => {
  await openFixture(page);
});

for (const name of [
  "max-height-column-flexed",
  "max-height-column-default",
] as const) {
  test(`a scroll area in a column bounded only by max-height scrolls above its footer (${name})`, async ({
    page,
  }) => {
    const geometry = await measure(page, name);
    expect(
      geometry.viewportScrollHeight,
      `${name}: content overflows the viewport, so the viewport scrolls`,
    ).toBeGreaterThan(geometry.viewportClientHeight);
    expect(geometry.footerTop, `${name}: footer`).not.toBeNull();
    expect(
      geometry.viewportBottom,
      `${name}: viewport ends above the footer`,
    ).toBeLessThanOrEqual((geometry.footerTop ?? 0) + TOLERANCE_PX);
    expect(
      geometry.footerHit,
      `${name}: footer button is what its centre hits`,
    ).toBe(true);
    await scrollsToLastLine(page, name);
  });
}

test("a scroll area in a column bounded only by max-height stays as short as short content", async ({
  page,
}) => {
  const name = "max-height-column-short";
  const geometry = await measure(page, name);
  const frame = await page.locator(`[data-case="${name}"]`).boundingBox();
  expect(frame).not.toBeNull();
  expect(geometry.viewportScrollHeight).toBeLessThanOrEqual(
    geometry.viewportClientHeight + TOLERANCE_PX,
  );
  // Two lines and a footer leave most of the 300px frame empty: the card
  // keeps its content height rather than filling the frame.
  expect(geometry.boundBottom - (frame?.y ?? 0)).toBeLessThan(200);
  expect(geometry.footerHit).toBe(true);
});

for (const [name, height] of [
  ["own-max-height", 160],
  ["definite-height", 160],
] as const) {
  test(`a scroll area bounded by its own classes scrolls inside them (${name})`, async ({
    page,
  }) => {
    const geometry = await measure(page, name);
    expect(geometry.rootHeight).toBeCloseTo(height, 0);
    expect(geometry.viewportClientHeight).toBeCloseTo(height, 0);
    expect(geometry.viewportScrollHeight).toBeGreaterThan(
      geometry.viewportClientHeight,
    );
    expect(geometry.viewportBottom).toBeLessThanOrEqual(
      geometry.boundBottom + TOLERANCE_PX,
    );
    await scrollsToLastLine(page, name);
  });
}

test("a scroll area keeps what is positioned inside it from scrolling a positioned frame around it", async ({
  page,
}) => {
  const viewports = page.locator(
    '[data-case="positioned-frame"] [data-slot="scroll-area-viewport"]',
  );
  const extent = async (index: number) =>
    await viewports.nth(index).evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
  const [outer, inner] = await Promise.all([extent(0), extent(1)]);
  expect(
    inner.scrollHeight,
    "the rows overflow, so the inner scroll area scrolls",
  ).toBeGreaterThan(inner.clientHeight);
  expect(
    outer.scrollHeight,
    "the outer scroll has nothing past its bottom to scroll to",
  ).toBeLessThanOrEqual(outer.clientHeight + TOLERANCE_PX);
});

test("a scroll area with no bound is as tall as its content", async ({
  page,
}) => {
  const geometry = await measure(page, "unbounded");
  const content = await page
    .locator('[data-case="unbounded"] ul')
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(geometry.rootHeight).toBeCloseTo(content, 0);
  expect(geometry.viewportClientHeight).toBeCloseTo(content, 0);
  expect(geometry.viewportScrollHeight).toBeLessThanOrEqual(
    geometry.viewportClientHeight + TOLERANCE_PX,
  );
});
