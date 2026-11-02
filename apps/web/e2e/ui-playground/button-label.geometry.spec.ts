/**
 * A button never grows past the card around it.
 *
 * The bench at `/dev?visual=button-label` puts a label wider than its card
 * into buttons of several shapes, in cards that stack their content at the
 * start, so nothing but the button itself keeps the label in. A one-line
 * label is cut with an ellipsis inside the card; a wrapping one takes more
 * lines and stays whole. Every project runs this, so it is measured under
 * `ar` (RTL) as well.
 */

import { buttonLabelBenches } from "../../src/routes/dev/-visual-metadata";
import {
  expect,
  test,
  waitForStableGeometry,
} from "../helpers/stable-geometry";

// Subpixel layout can put an edge a fraction past its container.
const EPSILON_PX = 0.5;

for (const [state, expected] of Object.entries(buttonLabelBenches)) {
  test(`the ${state} button stays inside its card`, async ({ page }) => {
    await page.goto("/dev?visual=button-label", {
      waitUntil: "domcontentloaded",
    });
    const section = page.locator(
      `[data-playground-section="button-label:${state}"]`,
    );
    const button = section.getByRole("button");
    await expect(button).toBeVisible();
    await waitForStableGeometry(page, section);

    const geometry = await section.evaluate((card) => {
      const target = card.querySelector("button");
      if (target === null) {
        throw new Error("The bench rendered no button.");
      }
      const label = target.querySelector('[data-slot="button-label"]');
      const cardBox = card.getBoundingClientRect();
      const buttonBox = target.getBoundingClientRect();
      return {
        card: { left: cardBox.left, right: cardBox.right },
        button: { left: buttonBox.left, right: buttonBox.right },
        buttonHeight: buttonBox.height,
        label:
          label instanceof HTMLElement
            ? {
                cut: label.scrollWidth > label.clientWidth,
                text: label.textContent,
              }
            : null,
      };
    });

    expect(geometry.button.left).toBeGreaterThanOrEqual(
      geometry.card.left - EPSILON_PX,
    );
    expect(geometry.button.right).toBeLessThanOrEqual(
      geometry.card.right + EPSILON_PX,
    );
    if (expected === "wrap") {
      // Whole, on more than one line.
      expect(geometry.label).toBeNull();
      expect(geometry.buttonHeight).toBeGreaterThan(48);
    } else {
      // Cut to fit, with the whole text still in the DOM.
      expect(geometry.label?.cut).toBe(true);
      expect(geometry.label?.text).toContain("náhradných dielov pre výrobu");
    }
  });
}
