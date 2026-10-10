import { expect, test } from "@playwright/test";

for (const controlled of [false, true]) {
  for (const custom of [false, true]) {
    for (const locale of ["en", "ar"] as const) {
      test(`Escape preserves then discards a ${controlled ? "controlled" : "uncontrolled"} ${custom ? "custom" : "native"} form in ${locale}`, async ({
        page,
      }) => {
        await page.goto("/src/components/fixtures/dialog.fixture.html", {
          waitUntil: "domcontentloaded",
        });
        if (controlled) {
          await page.getByLabel("Controlled").check();
        }
        if (custom) {
          await page.getByLabel("Custom form").check();
        }
        if (locale === "ar") {
          await page.getByRole("button", { name: "Switch language" }).click();
        }
        await page.getByRole("button", { name: "Open editor" }).click();
        const editor = page.getByRole("dialog");
        const input = page.getByLabel("Question", { exact: true });
        await input.focus();
        await page.keyboard.press("Escape");
        await expect(editor).not.toBeVisible();

        await page.getByRole("button", { name: "Open editor" }).click();
        await input.fill("Changed question");
        // Repeated keydowns from one held key are one discard request.
        await page.keyboard.down("Escape");
        await page.keyboard.down("Escape");
        await page.keyboard.up("Escape");
        await expect(editor).toBeVisible();
        await expect(editor.getByRole("status")).toHaveText(
          locale === "en"
            ? "Unsaved changes. Press Esc again to discard"
            : "تغييرات غير محفوظة. اضغط على Esc مرة أخرى لتجاهلها",
        );
        await expect(input).toHaveValue("Changed question");
        await expect(input).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(editor).not.toBeVisible();
        await expect(page.getByLabel("Stored draft")).toHaveText(
          "Stored question",
        );
        await page.getByRole("button", { name: "Open editor" }).click();
        await expect(input).toHaveValue("Stored question");
        await input.fill("Changed question");
        await input.fill("Stored question");
        await page.keyboard.press("Escape");
        await expect(editor).not.toBeVisible();
      });
    }
  }
}

test("a nested clean dialog consumes Escape before its dirty parent", async ({
  page,
}) => {
  await page.goto("/src/components/fixtures/dialog.fixture.html", {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: "Open editor", exact: true }).click();
  await page.getByLabel("Question", { exact: true }).fill("Changed question");
  await page.getByRole("button", { name: "Open nested editor" }).click();
  await page.getByLabel("Nested field").focus();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Nested editor" }),
  ).not.toBeVisible();
  const parent = page.getByRole("dialog", { name: "Edit question" });
  await expect(parent).toBeVisible();
  await expect(parent.getByRole("status")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(parent.getByRole("status")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(parent).not.toBeVisible();
});

test("the close button discards a persistent form without retaining the hint on reopen", async ({
  page,
}) => {
  await page.goto("/src/components/fixtures/dialog.fixture.html", {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: "Open editor", exact: true }).click();
  await page.getByLabel("Question", { exact: true }).fill("Changed question");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Open editor", exact: true }).click();
  await expect(page.getByLabel("Question", { exact: true })).toHaveValue(
    "Stored question",
  );
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("a controlled owner that rejects closing retains its draft", async ({
  page,
}) => {
  await page.goto("/src/components/fixtures/dialog.fixture.html", {
    waitUntil: "domcontentloaded",
  });
  await page.getByLabel("Controlled").check();
  await page.getByLabel("Reject close").check();
  await page.getByRole("button", { name: "Open editor", exact: true }).click();
  await page.getByLabel("Question", { exact: true }).fill("Changed question");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("status")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Question", { exact: true })).toHaveValue(
    "Changed question",
  );
  await expect(page.getByLabel("Stored draft")).toHaveText("Changed question");
});

test("external handles retain their typed trigger payload and close on first Escape", async ({
  page,
}) => {
  await page.goto("/src/components/fixtures/dialog.fixture.html", {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: "Open handled editor" }).click();
  const editor = page.getByRole("dialog", { name: "Handled editor" });
  await expect(editor).toBeVisible();
  await expect(page.getByLabel("Trigger payload")).toHaveText(
    "Handled question",
  );
  await page.keyboard.press("Escape");
  await expect(editor).not.toBeVisible();
});

test("discard confirmation supplies X even when ordinary chrome omits it", async ({
  page,
}) => {
  await page.goto("/src/components/fixtures/dialog.fixture.html", {
    waitUntil: "domcontentloaded",
  });
  await page.getByLabel("Show close button").uncheck();
  await page.getByRole("button", { name: "Open editor", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Close", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Question", { exact: true }).fill("Changed question");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("status")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByLabel("Stored draft")).toHaveText("Stored question");
});
