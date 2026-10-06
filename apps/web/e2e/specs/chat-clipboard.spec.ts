import { expect, test } from "../helpers/test";

test("a word copied from a transcript pastes only that selection", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/chat", { waitUntil: "commit" });
  const composer = page.locator('[role="textbox"][contenteditable="true"]');
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill("Clipboard");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/u, { timeout: 30_000 });
  const transcript = page.getByRole("log");
  await expect(transcript.getByRole("button", { name: "Retry" })).toBeVisible({
    timeout: 30_000,
  });

  await transcript.getByText("Clipboard", { exact: true }).dblclick();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    "Clipboard",
  );
  await page.keyboard.press("ControlOrMeta+c");
  const clipboard = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items.at(0);
    if (item === undefined) {
      throw new Error("Copy did not write a clipboard item");
    }
    return {
      plain: await (await item.getType("text/plain")).text(),
      html: await (await item.getType("text/html")).text(),
    };
  });
  expect(clipboard.plain).toBe("Clipboard");
  expect(clipboard.html).not.toMatch(/<(?:main|nav|article|footer|button)\b/iu);
  await composer.click();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(composer).toHaveText("Clipboard");
  await expect(composer.locator('[data-source="paste"]')).toHaveCount(0);
});

test("composer ignores whole-page HTML when plain text is short or absent", async ({
  page,
}) => {
  await page.goto("/chat", { waitUntil: "commit" });
  const composer = page.locator('[role="textbox"][contenteditable="true"]');
  await expect(composer).toBeVisible({ timeout: 30_000 });
  const html =
    "<main><nav>Unselected navigation</nav><article><p>Unselected thread</p><button>Technical action</button></article><footer>Unselected footer</footer></main>";
  for (const plain of ["Selected word", ""]) {
    await composer.fill("");
    await composer.evaluate(
      (element, data) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/html", data.html);
        if (data.plain !== "") {
          clipboardData.setData("text/plain", data.plain);
        }
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
      },
      { html, plain },
    );
    await expect(composer).toHaveText(plain);
    await expect(composer.locator("button, nav, footer, article")).toHaveCount(
      0,
    );
  }
});
