import { expect, test } from "@playwright/test";

// The seeded e2e user (test@stella.dev) is an org owner whose org has NO
// usage_entitlements row — the dark-launch default every production org
// starts in. We deliberately do not create an entitlement here: regressions
// that only surface in that default state must fail this spec.
test("chat composer sends a message and renders the assistant reply", async ({
  page,
}) => {
  await page.goto("/chat");

  // Route error boundary heading (apps/web/src/components/route-components.tsx:253,
  // title common.somethingWentWrong). Checked after every step below; declared
  // once so the assertions read the same way each time.
  const errorBoundary = page.getByRole("heading", {
    name: "Something went wrong",
  });
  await expect(errorBoundary).toHaveCount(0);

  // The composer's contenteditable carries an explicit role and
  // aria-label (chat-editor-provider editorProps); the name filter
  // keeps the locator unique even when other textbox-role editors
  // (e.g. folio) are mounted.
  const composer = page.getByRole("textbox", { name: /type your question/iu });
  // First locator after navigation: a cold Vite dev server compiles the
  // chat route chunk on demand, which can exceed the default 10s expect
  // timeout on a fresh CI runner (see playwright.config.ts).
  await expect(composer).toBeVisible({ timeout: 30_000 });

  const messageText = "Hello from the stella e2e chat spec";
  await composer.click();
  await composer.pressSequentially(messageText);

  await page.getByRole("button", { name: "Send message" }).click();

  // Sending from /chat fires the request and navigates to the new
  // thread (apps/web/src/routes/_protected.chat/index.tsx:389); the
  // thread id is a client-generated uuidv7.
  await expect(page).toHaveURL(
    /\/chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  );

  const transcript = page.getByRole("log");
  await expect(transcript.getByText(messageText)).toBeVisible();

  // A "Copy" action renders only under an assistant message that has
  // non-empty text (AssistantMessageActions in
  // apps/web/src/components/chat/chat-thread-messages.tsx) — neither the
  // thinking indicator nor the error bubble has one — so its presence
  // proves an actual reply painted, independent of what the registered
  // mock model streams. Generous timeout: cold Vite chunks + the
  // streamed response both land inside this wait.
  await expect(transcript.getByRole("button", { name: "Copy" })).toBeVisible({
    timeout: 30_000,
  });

  // "Retry" appears on the latest assistant message only once the
  // stream finished, so waiting for it pins the turn as complete before
  // the negative assertions below — otherwise an error chunk arriving
  // after partial text could slip past them.
  await expect(transcript.getByRole("button", { name: "Retry" })).toBeVisible({
    timeout: 30_000,
  });

  // Every ChatErrorMessage variant renders a "Resend" button
  // (apps/web/src/components/chat/chat-thread-messages.tsx:329-340);
  // zero of them means the turn ended without a stream error.
  await expect(transcript.getByRole("button", { name: "Resend" })).toHaveCount(
    0,
  );
  await expect(errorBoundary).toHaveCount(0);
});
