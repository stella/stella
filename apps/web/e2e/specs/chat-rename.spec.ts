import { expect, test } from "../helpers/test";

// Rename-with-suggestion on a persisted thread: the breadcrumb opens the
// inline editor, the wand fetches a suggestion into the draft, and a commit
// propagates to every surface that shows the title. The mock AI model's
// suggestion text is not asserted literally (the background titling on
// thread creation draws from the same mock, so the two can coincide); the
// deterministic assertion is the committed title's propagation.
test("breadcrumb rename with suggestion propagates to the threads sheet", async ({
  page,
}) => {
  // A route is ready when its UI is ready, not when every cold Vite resource
  // has fired the browser load event. Commit the document, then synchronize
  // on the composer below.
  await page.goto("/chat", { waitUntil: "commit" });

  const composer = page.getByRole("textbox", { name: /type your question/iu });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.click();
  await composer.pressSequentially("Draft a mutual NDA for a software vendor.");
  await page.getByRole("button", { name: "Send message" }).click();

  // Sending from /chat navigates to the freshly created thread.
  await expect(page).toHaveURL(
    /\/chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    { timeout: 30_000 },
  );
  const threadPath = new URL(page.url()).pathname;
  // "Copy" only renders under an assistant message with non-empty text, so
  // its presence pins the reply as painted (and the thread as persisted)
  // before the rename below.
  const transcript = page.getByRole("log");
  await expect(transcript.getByRole("button", { name: "Copy" })).toBeVisible({
    timeout: 30_000,
  });

  // The thread crumb doubles as the rename affordance: clicking it swaps the
  // label for the inline editor.
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await breadcrumb.getByRole("button").last().click();
  const renameInput = breadcrumb.getByRole("textbox");
  await expect(renameInput).toBeVisible();

  // Intercept the suggestion read so the assertion proves that its exact
  // response reached the draft. This also keeps keyboard focus coverage
  // deterministic regardless of mock-model output.
  const suggestedTitle = "Suggested title from the e2e endpoint";
  await page.route("**/chat/threads/*/title/suggest*", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ title: suggestedTitle }),
      contentType: "application/json",
      status: 200,
    });
  });
  const wand = breadcrumb.getByRole("button", { name: "Suggest a title" });
  await expect(wand).toBeEnabled();
  await renameInput.press("Tab");
  await expect(wand).toBeFocused();
  await wand.press("Enter");
  await expect(
    breadcrumb.getByRole("button", { name: "Suggesting a title…" }),
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(wand).toBeEnabled({ timeout: 30_000 });
  await expect(renameInput).toHaveValue(suggestedTitle);

  // Commit a deterministic title on top of the suggestion so the
  // propagation assertions below cannot depend on mock-model output.
  const committedTitle = "Renamed by the e2e wand spec";
  await renameInput.fill(committedTitle);
  await renameInput.press("Tab");
  await wand.press("Tab");
  const done = breadcrumb.getByRole("button", { name: "Done" });
  await expect(done).toBeFocused();
  await done.press("Enter");

  // Breadcrumb reflects the committed title (the editor is gone).
  await expect(breadcrumb.getByRole("textbox")).toHaveCount(0);
  await expect(
    breadcrumb.getByRole("button", { name: committedTitle }),
  ).toBeVisible({ timeout: 30_000 });

  // The threads sheet lists this exact thread under the new title. Persistent
  // test data may contain duplicate titles, so target the current route href.
  await page.getByRole("button", { name: "History" }).click();
  const sheet = page.getByRole("dialog");
  const currentThreadLink = sheet.locator(`a[href="${threadPath}"]`);
  await expect(currentThreadLink).toContainText(committedTitle, {
    timeout: 30_000,
  });
});
