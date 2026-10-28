import { expect, type Page, test } from "@playwright/test";

const fixturePath = "/src/components/fixtures/middle-truncate.fixture.html";

test.use({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});

const openFixture = async (page: Page, query = "") => {
  await page.addInitScript(() => {
    window.addEventListener("error", ({ message }) => {
      document.documentElement.dataset["testError"] = message;
    });
  });
  await page.goto(`${fixturePath}${query}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-slot=middle-truncate]")).toBeVisible();
};

const setFrameWidth = async (page: Page, width: number) =>
  await page.getByTestId("frame").evaluate(async (frame, inlineSize) => {
    if (frame instanceof HTMLElement) {
      frame.style.inlineSize = `${String(inlineSize)}px`;
    }
    // Complete the frame that delivers resize notifications, then its paint.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  }, width);

/**
 * The distance between the tail's leading edge (its ellipsis) and the end of
 * the last whole grapheme that fits inside the head's box, measured from the
 * text itself. Flush means under a pixel: no blank slack and no half glyph
 * before the ellipsis.
 */
const measureCut = async (page: Page) =>
  await page.locator("[data-slot=middle-truncate]").evaluate((root) => {
    const [head, tail] = root.children;
    const text = head?.firstChild;
    if (
      !(head instanceof HTMLElement) ||
      !(tail instanceof HTMLElement) ||
      !(text instanceof Text)
    ) {
      return null;
    }
    const rtl = getComputedStyle(head).direction === "rtl";
    const headBox = head.getBoundingClientRect();
    const range = document.createRange();
    let visibleEnd = rtl ? headBox.right : headBox.left;
    let offset = 0;
    const segments = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(text.data);
    for (const { segment } of segments) {
      offset += segment.length;
      range.setStart(text, 0);
      range.setEnd(text, offset);
      const rect = range.getBoundingClientRect();
      const fits = rtl
        ? rect.left >= headBox.left - 0.5
        : rect.right <= headBox.right + 0.5;
      if (!fits) {
        break;
      }
      visibleEnd = rtl ? rect.left : rect.right;
    }
    const tailBox = tail.getBoundingClientRect();
    const tailStart = rtl ? tailBox.right : tailBox.left;
    return {
      gap: Math.abs(tailStart - visibleEnd),
      overflowing: Object.hasOwn(head.dataset, "overflow"),
      text: root.textContent,
    };
  });

for (const rtl of [false, true]) {
  const query = rtl ? "?rtl=true" : "";
  const label = rtl ? "right to left" : "left to right";

  test(`shows the whole value when it fits (${label})`, async ({ page }) => {
    await openFixture(page, query);
    await expect(page.locator("[data-overflow]")).toHaveCount(0);
  });

  test(`cuts the middle flush against the ellipsis (${label})`, async ({
    page,
  }) => {
    await openFixture(page, query);
    for (const width of [180, 163, 141]) {
      await setFrameWidth(page, width);
      await expect(page.locator("[data-overflow]")).toHaveCount(1);
      await expect
        .poll(async () => (await measureCut(page))?.gap ?? Infinity)
        .toBeLessThan(1);
    }
    await expect(page.locator("html")).not.toHaveAttribute("data-test-error");
  });

  test(`drops the ellipsis once the value fits again (${label})`, async ({
    page,
  }) => {
    await openFixture(page, query);
    await setFrameWidth(page, 150);
    await expect(page.locator("[data-overflow]")).toHaveCount(1);
    await setFrameWidth(page, 600);
    await expect(page.locator("[data-overflow]")).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveAttribute("data-test-error");
  });
}

test("keeps the full value as the text and accessible name", async ({
  page,
}) => {
  await openFixture(page);
  await setFrameWidth(page, 150);
  const cut = await measureCut(page);
  expect(cut?.overflowing).toBe(true);
  expect(cut?.text).toBe("Smlouva o dílo – revize klienta.docx");
});
