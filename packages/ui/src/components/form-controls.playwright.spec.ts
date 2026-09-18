import { expect, test } from "@playwright/test";

const fixturePath = "/src/components/fixtures/form-controls.fixture.html";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setAutoDarkModeOverride", { enabled: true });
  await page.goto(fixturePath);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["formControlsReady"] ?? "",
        ),
    )
    .toBe("true");
});

test("keeps portal-backed options readable in a forced dark color scheme", async ({
  page,
}) => {
  await page.getByRole("combobox", { name: "Category" }).click();

  const popup = page.locator('[data-slot="select-popup"]');
  const option = page.getByRole("option", { name: "Second category" });
  await expect(popup).toBeVisible();
  await expect(option).toBeVisible();

  const popupColors = await popup.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, foreground: style.color };
  });
  const optionColors = await option.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, foreground: style.color };
  });

  expect(popupColors).toEqual({
    background: "rgb(23, 23, 23)",
    foreground: "rgb(245, 245, 245)",
  });
  expect(optionColors.foreground).toBe("rgb(245, 245, 245)");
  expect(optionColors.foreground).not.toBe(optionColors.background);
});

test("preserves rapid numeric text until the value is committed", async ({
  page,
}) => {
  const input = page.getByRole("textbox", { name: "Quantity" });
  await input.pressSequentially("000", { delay: 1 });

  await expect(input).toHaveValue("000");
  await expect(page.getByLabel("Canonical quantity")).toHaveText("0");

  await input.blur();
  await expect(input).toHaveValue("0");
});

const sourceDocument = {
  name: "smlouva.docx",
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  buffer: Buffer.from("docx"),
};

test("FileInput opens the chooser from its trigger and reports the picked file", async ({
  page,
}) => {
  const trigger = page.getByRole("button", {
    name: "Source document Choose file",
  });
  const selected = page.getByLabel("Selected file");
  const nativeInput = page.locator(
    '[data-slot="file-input"] input[type="file"]',
  );

  const chooser = page.waitForEvent("filechooser");
  await trigger.click();
  await (await chooser).setFiles(sourceDocument);

  await expect(selected).toHaveText("smlouva.docx");
  await expect(page.locator('[data-slot="file-input-name"]')).toHaveText(
    "smlouva.docx",
  );
  await expect(nativeInput).toHaveValue("");

  await page.getByRole("button", { name: "Clear file" }).click();
  await expect(selected).toHaveText("none");

  // The input's value was cleared on change, so the same file fires again.
  await nativeInput.setInputFiles(sourceDocument);
  await expect(selected).toHaveText("smlouva.docx");
});
