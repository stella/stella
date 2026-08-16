import { expect, test } from "../helpers/test";

// Marker recognized by the mock AI adapter (apps/api/src/dev/register-mock-ai.ts,
// E2E_EMPTY_COMPLETION_MARKER) — grep either file to find the other. It cannot
// be imported here: this spec runs in apps/web and has no dependency on
// apps/api. When the latest user message contains it, the mock finishes the
// run with zero output, which makes the server throw ChatEmptyCompletionError
// (apps/api/src/handlers/chat/stream-chat.ts) and the client receive a real
// run-error event — the same shape as a provider empty completion in
// production.
const EMPTY_COMPLETION_MARKER = "Return an empty completion please";

// Regression: a first-turn stream error used to drive the thread page into a
// sustained render storm (~133 commits/sec) and drop the turn without any
// visible error state. The render-storm canary turns a recurrence into a
// console.error, which the auto `browserErrors` fixture
// (apps/web/e2e/helpers/test.ts) fails this spec on — the assertions below
// only need to pin the visible error affordance.
test("a first-turn stream error surfaces retry UI without a render storm", async ({
  page,
  browserErrors,
}) => {
  // The server classifies the empty completion and streams the kind as the
  // run error; the client's captureError echoes it to console.error in dev.
  // That echo is this spec's intended outcome, not a defect — declare it so
  // the auto fixture still fails on anything else (a render storm, a crash).
  // One declaration covers both failed turns below.
  browserErrors.expectCaptured(/empty_completion/u);

  await page.goto("/chat", { waitUntil: "commit" });

  const errorBoundary = page.getByRole("heading", {
    name: "This page couldn’t be opened",
  });
  await expect(errorBoundary).toHaveCount(0);

  const composer = page.getByRole("textbox", { name: /type your question/iu });
  await expect(composer).toBeVisible({ timeout: 30_000 });

  await composer.click();
  await composer.pressSequentially(EMPTY_COMPLETION_MARKER);
  await page.getByRole("button", { name: "Send message" }).click();

  // Sending from /chat fires the request and navigates to the new thread
  // (apps/web/src/routes/_protected.chat/index.tsx); the thread id is a
  // client-generated uuidv7.
  await expect(page).toHaveURL(
    /\/chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    { timeout: 30_000 },
  );

  const transcript = page.getByRole("log");

  // The user message must survive the failed turn — the incident dropped the
  // whole thread back to an empty state.
  await expect(transcript).toContainText(EMPTY_COMPLETION_MARKER, {
    timeout: 30_000,
  });

  // Every ChatErrorMessage variant renders a "Resend" button
  // (apps/web/src/components/chat/chat-thread-messages.tsx); its presence pins
  // the turn as visibly failed rather than silently swallowed.
  const resend = transcript.getByRole("button", { name: "Resend" });
  await expect(resend).toBeVisible({ timeout: 30_000 });
  // The kind-specific copy (chat.sendErrorEmptyCompletion), not the generic
  // send error: reverting the empty_completion classification in
  // apps/api/src/lib/ai-error.ts drops this back to generic copy and fails
  // here.
  await expect(transcript).toContainText(
    "The AI returned an empty reply. Try again or rephrase your message.",
  );
  await expect(errorBoundary).toHaveCount(0);

  // The incident's render storm fired after the SECOND failed turn (resend →
  // error again), in the window where the failed turn's refetch and the new
  // turn's optimistic state overlap. Exercise that exact sequence.
  await resend.click();
  await expect(resend).toBeVisible({ timeout: 30_000 });
  await expect(transcript).toContainText(EMPTY_COMPLETION_MARKER);
  await expect(errorBoundary).toHaveCount(0);

  // Hold the settled error state open long enough for the render-storm canary
  // (2 sustained one-second windows) to trip if the error path still loops;
  // the browserErrors fixture fails the spec on its console.error.
  await page.waitForTimeout(4000);
});
