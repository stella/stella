/**
 * A sortable head shows its whole label wherever its column has room.
 *
 * The bench at `/dev?visual=sortable-head` sets short labels in tables far
 * wider than them: with no rows, with rows, in a numeric column and as the
 * loading face. The sort button is pulled back by its padding so its label
 * lines up with the cells; it must neither cut the label nor reach past its
 * head. Every project runs this, so it is measured under `ar` (RTL) as well.
 */

import { sortableHeadBenches } from "../../src/routes/dev/-visual-metadata";
import {
  expect,
  test,
  waitForStableGeometry,
} from "../helpers/stable-geometry";

// Subpixel layout can put an edge a fraction past its container.
const EPSILON_PX = 0.5;

for (const state of Object.keys(sortableHeadBenches)) {
  test(`the ${state} heads show their whole labels`, async ({ page }) => {
    await page.goto("/dev?visual=sortable-head", {
      waitUntil: "domcontentloaded",
    });
    const section = page.locator(
      `[data-playground-section="sortable-head:${state}"]`,
    );
    await expect(section.locator("th[aria-sort]").first()).toBeVisible();
    await waitForStableGeometry(page, section);

    const heads = await section.evaluate((bench) =>
      [...bench.querySelectorAll("th[aria-sort]")].map((head) => {
        const label = head.querySelector('[data-slot="truncated-text"]');
        const control = label?.parentElement;
        if (!(label instanceof HTMLElement) || !(control instanceof Element)) {
          throw new TypeError("A sortable head rendered no label.");
        }
        const headBox = head.getBoundingClientRect();
        const controlBox = control.getBoundingClientRect();
        return {
          text: label.textContent,
          cut: label.scrollWidth > label.clientWidth,
          head: { left: headBox.left, right: headBox.right },
          control: { left: controlBox.left, right: controlBox.right },
        };
      }),
    );

    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) {
      expect(head, `${head.text} is cut`).toMatchObject({ cut: false });
      expect(head.control.left).toBeGreaterThanOrEqual(
        head.head.left - EPSILON_PX,
      );
      expect(head.control.right).toBeLessThanOrEqual(
        head.head.right + EPSILON_PX,
      );
    }
  });
}
