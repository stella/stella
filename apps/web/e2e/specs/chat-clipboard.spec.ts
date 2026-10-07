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

  const message = transcript.getByText("Clipboard", { exact: true });
  const wordPosition = await message.evaluate((element) => {
    const textNodes = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const text = textNodes.nextNode();
    if (text === null) {
      throw new Error("Message is missing its visible text node");
    }
    const range = document.createRange();
    range.selectNodeContents(text);
    const word = range.getBoundingClientRect();
    const messageRect = element.getBoundingClientRect();
    return {
      x: word.left - messageRect.left + word.width / 2,
      y: word.top - messageRect.top + word.height / 2,
    };
  });
  await message.dblclick({ position: wordPosition });
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
    // Clear through the editor: a programmatic fill does not reliably empty
    // the rich-text composer in production builds.
    await composer.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
    await expect(composer).toHaveText("");
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
