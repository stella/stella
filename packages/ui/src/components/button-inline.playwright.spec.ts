import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";

const fixturePath = "/src/components/fixtures/button-inline.fixture.html";

const CITATION =
  /^rozsudku Nejvyššího soudu ze dne 30\. 11\. 2016, sp\. zn\. 29 Cdo 4632\/2015$/u;

type Box = { top: number; left: number; right: number; bottom: number };

type Layout = { paragraph: Box; lineHeight: number; fragments: Box[] };

// The line boxes an inline element occupies, beside its paragraph's box.
const layoutOf = async (target: Locator): Promise<Layout> =>
  await target.evaluate((element) => {
    const box = ({ top, left, right, bottom }: DOMRect) => ({
      top,
      left,
      right,
      bottom,
    });
    const paragraph = element.closest("p");
    if (paragraph === null) {
      throw new Error("The action is not inside a paragraph");
    }
    return {
      paragraph: box(paragraph.getBoundingClientRect()),
      lineHeight: Number.parseFloat(getComputedStyle(paragraph).lineHeight),
      fragments: [...element.getClientRects()].map(box),
    };
  });

test.beforeEach(async ({ page }) => {
  await page.goto(fixturePath);
  await expect(page.locator('[data-slot="button-text-run"]')).toBeVisible();
});

test("a text run breaks across the paragraph's lines and stays one button", async ({
  page,
}) => {
  const run = page.locator('[data-slot="button-text-run"]');
  // Named by its label's text, and the only button in its paragraph.
  const scope = page.locator('[data-case="run"]');
  await expect(scope.getByRole("button")).toHaveCount(1);
  await expect(scope.getByRole("button", { name: CITATION })).toHaveCount(1);

  const { paragraph, lineHeight, fragments } = await layoutOf(run);
  expect(fragments.length).toBeGreaterThan(1);
  // It starts on the first line, after "Podle", rather than moving down whole.
  expect(fragments[0]?.bottom).toBeLessThanOrEqual(paragraph.top + lineHeight);
  expect(fragments[0]?.left).toBeGreaterThan(paragraph.left);
  for (const fragment of fragments) {
    expect(fragment.right).toBeLessThanOrEqual(paragraph.right + 0.5);
  }

  // A press on the last line, far from the button's own box, still acts.
  const last = fragments.at(-1);
  if (last === undefined) {
    throw new Error("The run has no line boxes");
  }
  await page.mouse.click(last.left + 2, (last.top + last.bottom) / 2);
  await expect(page.getByLabel("Run presses")).toHaveText("1");
});

test("a text run shows keyboard focus on its text", async ({ page }) => {
  const run = page.locator('[data-slot="button-text-run"]');
  await page.keyboard.press("Tab");
  await expect(
    page.locator('[data-case="run"]').getByRole("button", { name: CITATION }),
  ).toBeFocused();
  const ring = await run.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  );
  expect(ring).not.toBe("none");

  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Run presses")).toHaveText("1");
});

test("an inline button stays one box and never overflows its paragraph", async ({
  page,
}) => {
  const inline = page.locator('[data-case="inline"] [data-slot="button"]');
  const { paragraph, lineHeight, fragments } = await layoutOf(inline);

  expect(fragments).toHaveLength(1);
  const [box] = fragments;
  // It does not share the first line with "Podle": the whole box moved down.
  expect(box?.top).toBeGreaterThanOrEqual(paragraph.top + lineHeight);
  expect(box?.right).toBeLessThanOrEqual(paragraph.right + 0.5);
});

test("a selected plain button draws an edge an unselected one does not", async ({
  page,
}) => {
  const outlineOf = async (name: string) =>
    await page.getByRole("button", { name }).evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });

  expect(await outlineOf("Selected card")).toEqual({
    style: "solid",
    width: "2px",
  });
  expect((await outlineOf("Other card")).style).toBe("none");
});
