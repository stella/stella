import { expect, test } from "../helpers/test";

// A long, fast keystroke burst. Under the editor-update loop class this spec
// guards, per-keystroke draft persistence re-rendered the composer, the react
// binding re-applied editor options on every render, and the view churn fed
// ProseMirror's DOMObserver a fresh doc-changing transaction — sustaining the
// cycle until React threw "Maximum update depth exceeded" (caught here by the
// auto browserErrors fixture) and dropping in-flight keystrokes (caught by
// the full-text assertion). Short bursts stay under React's nested-update
// limit, so the length is load-bearing.
const BURST_TEXT =
  "Dear Jan Novák, please contact jan.novak@example.com or call " +
  "+420 777 123 456. Also Petr Svoboda and Marie Dvořáková from Praha " +
  "will attend the meeting soon.";

test("anonymized-mode typing keeps every keystroke and paints highlights", async ({
  page,
}) => {
  // The cold-start waits below (route compile 30s + first highlight 45s) can
  // exceed the suite's default 60s per-test timeout on a fresh runner.
  test.setTimeout(120_000);
  // A route is ready when its UI is ready, not when every cold resource has
  // fired the browser load event. Commit the document, then synchronize on
  // the composer below.
  await page.goto("/chat", { waitUntil: "commit" });

  // The composer's contenteditable carries an explicit role and aria-label
  // (chat-editor-provider editorProps).
  const composer = page.getByRole("textbox", { name: /type your question/iu });
  // First locator after navigation: a cold server can compile the chat route
  // chunk on demand, exceeding the default expect timeout.
  await expect(composer).toBeVisible({ timeout: 30_000 });

  // Enabling anonymized mode also warms up the wasm worker, so the pipeline
  // loads while the burst below is being typed.
  const anonymizedToggle = page.getByRole("button", {
    name: "Anonymized AI mode",
  });
  await anonymizedToggle.click();
  await expect(anonymizedToggle).toHaveAttribute("aria-pressed", "true");

  await composer.click();
  await composer.pressSequentially(BURST_TEXT);

  // Every keystroke survived: the loop class reverts in-flight input before
  // it trips React's guard, so lost characters are its earliest symptom.
  await expect(composer).toHaveText(BURST_TEXT);

  // The live preview decorates recognized entities inside the editor
  // (chat-anon-decorations-extension). Requires the anonymization worker to
  // boot and the wasm pipeline + name dictionaries to load — several seconds
  // cold, hence the generous timeout on the first highlight.
  const highlights = composer.locator(".stll-anon-highlight");
  await expect(highlights.filter({ hasText: "Jan Novák" }).first()).toBeVisible(
    { timeout: 45_000 },
  );
  await expect(
    highlights.filter({ hasText: "jan.novak@example.com" }).first(),
  ).toBeVisible();

  // The browserErrors fixture (auto) fails the spec on any console error —
  // React's max-update-depth crash surfaces there if the loop class returns.
});
