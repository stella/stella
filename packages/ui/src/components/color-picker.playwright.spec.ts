import { expect, test } from "@playwright/test";

const fixturePath = "/src/components/fixtures/color-picker.fixture.html";

test("popover presentation closes for presets and stays open for custom input", async ({
  page,
}) => {
  await page.goto(fixturePath);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["colorPickerReady"] ?? "",
        ),
    )
    .toBe("true");

  const trigger = page.locator('[data-slot="color-picker-trigger"]');
  const popup = page.locator('[data-slot="color-picker-popup"]');
  await trigger.click();
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: "Blue" }).click();
  await expect(popup).toBeHidden();
  await expect(page.getByRole("status", { name: "Selected color" })).toHaveText(
    "3B82F6",
  );

  await trigger.click();
  await popup.getByRole("button", { name: "Custom color" }).click();
  await expect(popup).toBeVisible();
  const customHex = popup.getByRole("textbox", { name: "Custom hex color" });
  await expect(customHex).toBeVisible();
  await customHex.fill("112233");
  await expect(page.getByRole("status", { name: "Selected color" })).toHaveText(
    "112233",
  );
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
});
