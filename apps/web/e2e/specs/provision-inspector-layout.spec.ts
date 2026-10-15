import {
  CURRENT_PROVISION_SENTENCE,
  installProvisionLayoutFixture,
  openProvisionLayoutInspector,
  PROVISION_LAYOUT_SENTENCE,
  readProvisionLayout,
} from "../helpers/provision-layout-fixture";
import { expect, test } from "../helpers/test";

const MIN_READING_WIDTH_RATIO = 0.6;
const MAX_SENTENCE_LINES = 4;

test("a provision opened from a decision uses the inspector's reading width", async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await installProvisionLayoutFixture(page);
  const article = await openProvisionLayoutInspector(page);
  const pane = page.locator('[data-slot="inspector-dock-pane"]');
  await expect(
    pane.getByText(/Version applied in Synthetic court SYN 25\/2023/u),
  ).toBeVisible();
  await expect(
    pane.getByRole("button", { name: "Current wording", exact: true }),
  ).toBeVisible();
  const handle = page.locator('[data-slot="inspector-resize-handle"]');
  for (const key of ["Enter", "Home"]) {
    await handle.press(key);
    await expect
      .poll(async () => {
        const { width, panelWidth } = await readProvisionLayout(page);
        return width / panelWidth;
      })
      .toBeGreaterThanOrEqual(MIN_READING_WIDTH_RATIO);
    const layout = await readProvisionLayout(page);
    expect(layout.lines).toBeGreaterThan(0);
    expect(layout.lines).toBeLessThanOrEqual(MAX_SENTENCE_LINES);
    await expect(
      article.getByText(PROVISION_LAYOUT_SENTENCE, { exact: true }),
    ).toBeVisible();
  }
  await pane
    .getByRole("button", { name: "Current wording", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    article.getByText(CURRENT_PROVISION_SENTENCE, { exact: true }),
  ).toBeVisible();
  await expect(pane.getByText(/Version applied in/u)).toHaveCount(0);
});
