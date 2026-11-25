import { expect, type Page, test } from "@playwright/test";

const fixturePath = "/src/components/fixtures/composer-frame.fixture.html";

test.use({
  viewport: { width: 1280, height: 900 },
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
});

// Subpixel layout can put an edge a fraction past its container.
const EPSILON_PX = 1;
// A line that wraps at the fixture's 360px width, and one that does not.
const ONE_LINE = "Draft the reply to opposing counsel";
const TWO_LINES =
  "Draft the reply to opposing counsel about the disclosure schedule and the deadline the court set";

const openFixture = async (page: Page, query = "") => {
  await page.goto(`${fixturePath}${query}`);
  await expect(frame(page)).toBeVisible();
};

const frame = (page: Page) => page.locator('[data-slot="composer-frame"]');
const message = (page: Page) => page.getByRole("textbox", { name: "Message" });

type Rect = { top: number; bottom: number; left: number; right: number };

const geometry = async (page: Page) =>
  frame(page).evaluate((box) => {
    const rect = (element: Element | null): Rect => {
      if (element === null) {
        throw new Error("The frame is missing a part.");
      }
      const { top, bottom, left, right } = element.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    const viewport = box.querySelector('[data-slot="scroll-area-viewport"]');
    return {
      box: rect(box),
      region: rect(box.querySelector('[data-slot="composer-text-region"]')),
      viewport: rect(viewport),
      scrollHeight: viewport?.scrollHeight ?? 0,
      clientHeight: viewport?.clientHeight ?? 0,
      leading: rect(box.querySelector('[data-slot="composer-leading"]')),
      trailing: rect(box.querySelector('[data-slot="composer-trailing"]')),
      thumb: rect(box.querySelector('[data-slot="scroll-area-scrollbar"]')),
    };
  });

test("stays one 44px bar while the draft fits one line", async ({ page }) => {
  await openFixture(page);
  await expect(frame(page)).toHaveAttribute("data-composer-layout", "bar");
  const { box } = await geometry(page);
  expect(Math.round(box.bottom - box.top)).toBe(44);
  await message(page).fill(ONE_LINE);
  await expect(frame(page)).toHaveAttribute("data-composer-layout", "bar");
});

test("stacks the text over the controls on a second line, and only an empty draft brings the bar back", async ({
  page,
}) => {
  await openFixture(page);
  await message(page).fill(TWO_LINES);
  await expect(frame(page)).toHaveAttribute("data-composer-layout", "stacked");
  const stacked = await geometry(page);
  // The text spans the box; the controls sit in a row below it.
  expect(stacked.trailing.top).toBeGreaterThanOrEqual(
    stacked.region.bottom - EPSILON_PX,
  );
  expect(stacked.leading.top).toBeGreaterThanOrEqual(
    stacked.region.bottom - EPSILON_PX,
  );

  // Back to a line that would fit the bar: it stays stacked, so it never
  // flips at the wrap point while someone types.
  await message(page).fill(ONE_LINE);
  await expect(frame(page)).toHaveAttribute("data-composer-layout", "stacked");

  await message(page).fill("");
  await expect(frame(page)).toHaveAttribute("data-composer-layout", "bar");
  await expect(message(page)).toBeFocused();
});

test("a line break stacks the frame too", async ({ page }) => {
  await openFixture(page);
  await message(page).focus();
  await page.keyboard.type("Clause 4");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("Clause 5");
  await expect(frame(page)).toHaveAttribute("data-composer-layout", "stacked");
  // The textbox survived the switch: typing continues where it was.
  await page.keyboard.type(" and 6");
  await expect(message(page)).toHaveValue("Clause 4\nClause 5 and 6");
});

for (const dir of ["ltr", "rtl"] as const) {
  test(`a long draft scrolls in its own region, its scrollbar at the box's inline end (${dir})`, async ({
    page,
  }) => {
    await openFixture(page, `?dir=${dir}`);
    await message(page).fill(
      Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1}`).join(
        "\n",
      ),
    );
    await expect(frame(page)).toHaveAttribute(
      "data-composer-layout",
      "stacked",
    );
    const long = await geometry(page);
    // The region stops growing at 320px and scrolls inside.
    expect(Math.round(long.region.bottom - long.region.top)).toBe(320);
    expect(long.scrollHeight).toBeGreaterThan(long.clientHeight);
    // Its inline-end edge is the box's, inside the 1px border.
    if (dir === "ltr") {
      expect(Math.abs(long.box.right - 1 - long.region.right)).toBeLessThan(
        EPSILON_PX,
      );
      expect(long.box.right - long.thumb.right).toBeLessThan(6);
    } else {
      expect(Math.abs(long.region.left - (long.box.left + 1))).toBeLessThan(
        EPSILON_PX,
      );
      expect(long.thumb.left - long.box.left).toBeLessThan(6);
    }
    // Nothing that holds a control overlaps the region.
    expect(long.trailing.top).toBeGreaterThanOrEqual(
      long.region.bottom - EPSILON_PX,
    );
    expect(long.leading.top).toBeGreaterThanOrEqual(
      long.region.bottom - EPSILON_PX,
    );
  });
}
