import { expect, test } from "../helpers/test";

// Marker recognized by the mock AI adapter (apps/api/src/dev/register-mock-ai.ts,
// E2E_SLOW_STREAM_MARKER) — grep either file to find the other. It cannot be
// imported here: this spec runs in apps/web and has no dependency on apps/api.
// When the latest user message contains it, the mock streams its reply as ~60
// delayed chunks (~3s total) instead of one instant chunk, giving this spec a
// real window to type into the composer while a response is still streaming.
const SLOW_STREAM_MARKER = "[e2e:slow-stream]";

// The seeded e2e user (test@stella.dev) is an org owner whose org has NO
// usage_entitlements row — the dark-launch default every production org
// starts in. We deliberately do not create an entitlement here: regressions
// that only surface in that default state must fail this spec.
test("composer draft survives typing while a response is streaming", async ({
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

  const messageText = `Stream slowly please ${SLOW_STREAM_MARKER}`;
  await composer.click();
  await composer.pressSequentially(messageText);

  await page.getByRole("button", { name: "Send message" }).click();

  // Sending from /chat fires the request and navigates to the new
  // thread (apps/web/src/routes/_protected.chat/index.tsx:389); the
  // thread id is a client-generated uuidv7.
  // The thread-creation request + client nav can exceed the default 10s expect
  // timeout on a cold CI runner — the same headroom the waits below use.
  await expect(page).toHaveURL(
    /\/chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    { timeout: 30_000 },
  );

  // The mock reply streams for ~3s once the marker is recognized (see
  // register-mock-ai.ts). Type into the composer immediately, overlapping
  // the assistant message's re-renders as chunks keep arriving — a
  // regression that re-runs the whole composer subtree on every stream
  // chunk (or worse, loops it) would either drop keystrokes or throw
  // React's "Maximum update depth exceeded", which the auto `browserErrors`
  // fixture (apps/web/e2e/helpers/test.ts) turns into a console.error and
  // fails this test on its own — no explicit assertion needed for that class
  // of bug.
  //
  // Known soft spot: on an extremely slow cold run the stream could finish
  // before typing begins here, which degrades this spec back to a
  // non-overlapping smoke test rather than breaking it outright. The ~3s
  // window is sized to make that unlikely on a normal CI runner.
  const draftText = "Draft typed while assistant is replying";
  await composer.click();
  await composer.pressSequentially(draftText, { delay: 30 });

  const transcript = page.getByRole("log");
  // "Retry" appears on the latest assistant message only once the stream
  // finished, so waiting for it pins the turn as complete before the
  // assertions below.
  await expect(transcript.getByRole("button", { name: "Retry" })).toBeVisible({
    timeout: 30_000,
  });

  // The draft typed during streaming must have survived every re-render the
  // stream chunks triggered along the way.
  await expect(composer).toContainText(draftText);

  // Every ChatErrorMessage variant renders a "Resend" button
  // (apps/web/src/components/chat/chat-thread-messages.tsx:329-340);
  // zero of them means the turn ended without a stream error.
  await expect(transcript.getByRole("button", { name: "Resend" })).toHaveCount(
    0,
  );
  await expect(errorBoundary).toHaveCount(0);
});
