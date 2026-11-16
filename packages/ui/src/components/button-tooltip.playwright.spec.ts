import { expect, type Page, test } from "@playwright/test";

import { BUTTON_CONTENT } from "./button";

const fixturePath = "/src/components/fixtures/button-tooltip.fixture.html";

test.use({
  viewport: { width: 1280, height: 800 },
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
});

type SizeRow = { size: string; content: string };

// The sizes come from `BUTTON_SIZE_CONTENT` as the fixture renders it, so a
// new size is covered without touching this spec.
const readSizes = async (page: Page): Promise<SizeRow[]> => {
  await page.goto(fixturePath);
  const sections = page.locator("section[data-size]");
  await expect(sections.first()).toBeVisible();
  return sections.evaluateAll((nodes) =>
    nodes.map((node) => ({
      size: node.dataset["size"] ?? "",
      content: node.dataset["content"] ?? "",
    })),
  );
};

const openByKeyboard = async (page: Page, size: string) => {
  await page.goto(fixturePath);
  const trigger = page.getByRole("button", {
    name: `Open the ${size} outline`,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  return trigger;
};

const tooltips = (page: Page) => page.locator('[data-slot="tooltip-popup"]');

test("a button showing text never opens an implicit tooltip, so the first Escape closes its popover", async ({
  page,
}) => {
  const sizes = (await readSizes(page)).filter(
    ({ content }) => content === BUTTON_CONTENT.text,
  );
  expect(sizes.length).toBeGreaterThan(0);
  for (const { size } of sizes) {
    await test.step(size, async () => {
      const trigger = await openByKeyboard(page, size);
      const row = page.getByRole("button", {
        name: `Go to the ${size} reasoning`,
      });
      // The fixture reaches the fault: the label differs from the text, and
      // the popup has moved focus onto the row.
      await expect(row).toHaveText("Reasoning");
      await expect(row).toBeFocused();
      await expect(row).not.toHaveAttribute("data-base-ui-tooltip-trigger");

      await page.keyboard.press("Escape");
      await expect(row).toBeHidden();
      // Focus returns to the trigger, which also shows text under a
      // differing label.
      await expect(trigger).toBeFocused();
      await expect(trigger).not.toHaveAttribute("data-base-ui-tooltip-trigger");
      await expect(tooltips(page)).toHaveCount(0);
    });
  }
});

test("an icon-only button still names itself in a tooltip", async ({
  page,
}) => {
  const sizes = (await readSizes(page)).filter(
    ({ content }) => content === BUTTON_CONTENT.icon,
  );
  expect(sizes.length).toBeGreaterThan(0);
  for (const { size } of sizes) {
    await test.step(size, async () => {
      await openByKeyboard(page, size);
      const name = `Add a ${size} section`;
      const row = page.getByRole("button", { name });
      await expect(row).toBeFocused();
      await expect(tooltips(page)).toHaveText(name);
    });
  }
});
