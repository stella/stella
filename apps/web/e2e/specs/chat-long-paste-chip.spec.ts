import { expect, test } from "../helpers/test";

for (const key of ["Enter", "Space"]) {
  test(`pasted text expands and removes through ${key}, returning focus to the composer`, async ({
    page,
  }) => {
    await page.goto("/chat", { waitUntil: "commit" });
    const composer = page.locator('[role="textbox"][contenteditable="true"]');
    await expect(composer).toBeVisible({ timeout: 30_000 });
    const text = `Pasted contract excerpt\r\n\t${"A".repeat(1501)}\n `;
    const paste = async () => {
      await composer.evaluate((element, content) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", content);
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
      }, text);
    };
    await composer.click();
    await paste();
    const expand = page.getByRole("button", {
      name: "Show in text field",
      exact: true,
    });
    await expect(expand).toBeVisible();
    await expect(composer).toHaveText("");
    await expand.focus();
    await page.keyboard.press("Shift+Tab");
    const focusedTitle = await page.evaluate(
      () => document.activeElement?.textContent,
    );
    expect(focusedTitle).toBe("Pasted contract excerpt");
    await page.keyboard.press("Tab");
    await expect(expand).toBeFocused();
    await page.keyboard.press(key);
    await expect(expand).toHaveCount(0);
    await expect(composer).toBeFocused();
    expect(await composer.evaluate((element) => element.textContent)).toBe(
      text,
    );

    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
    await expect(composer).toHaveText("");
    await composer.pressSequentially("Existing question");
    await paste();
    await expect(expand).toBeVisible();
    await expand.focus();
    await page.keyboard.press("Tab");
    const remove = page.getByRole("button", { name: "Remove", exact: true });
    await expect(remove).toBeFocused();
    await page.keyboard.press(key);
    await expect(expand).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveText("Existing question");
  });
}
