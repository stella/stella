import { ROUTE_ERROR_HEADING } from "../helpers/app-shell";
import { expect, test } from "../helpers/test";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";

// The registered mock keeps producing paced durable batches until Stop.
const CONTINUOUS_STREAM_MARKER = "Stream continuously please";

// The seeded e2e user (test@stella.dev) is an org owner whose org has NO
// usage_entitlements row — the dark-launch default every production org
// starts in. We deliberately do not create an entitlement here: regressions
// that only surface in that default state must fail this spec.
test("composer draft survives typing while a response is streaming", async ({
  page,
}) => {
  // A route is ready when its UI is ready, not when every cold Vite resource
  // has fired the browser load event. Commit the document, then synchronize on
  // the composer below.
  await page.goto("/chat", { waitUntil: "commit" });

  // Route error boundary heading (apps/web/src/components/route-components.tsx,
  // title routeError.title). Checked after every step below; declared
  // once so the assertions read the same way each time.
  const errorBoundary = page.getByRole("heading", {
    name: ROUTE_ERROR_HEADING,
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
  await expect(composer).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });

  await composer.click();
  await composer.pressSequentially("Start this test thread");

  await page.getByRole("button", { name: "Send message" }).click();

  // Sending from /chat fires the request and navigates to the new
  // thread (apps/web/src/routes/_protected.chat/index.tsx:389); the
  // thread id is a client-generated uuidv7.
  // The thread-creation request + client nav can exceed the default 10s expect
  // timeout on a cold CI runner — the same headroom the waits below use.
  await expect(page).toHaveURL(
    /\/chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    { timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS },
  );

  const transcript = page.getByRole("log");
  await expect(transcript.getByRole("button", { name: "Retry" })).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });

  // New-thread navigation settles after its first response, so exercise the
  // overlap on a second turn inside the stable thread route. The editor's
  // suggested-follow-up label is dynamic after a response; role and
  // contenteditable identify the same composer without coupling to that copy.
  const threadComposer = page.locator(
    '[role="textbox"][contenteditable="true"]',
  );
  await threadComposer.click();
  await threadComposer.pressSequentially(CONTINUOUS_STREAM_MARKER);
  await page.getByRole("button", { name: "Send message" }).click();

  const stopButton = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stopButton).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  const answer = transcript.getByText("This mock reply streams back", {
    exact: false,
  });
  await expect(answer).toBeVisible();
  const beforeTyping = await answer.textContent();

  // The provider keeps emitting while keystrokes exercise chunk-driven renders.
  const draftText = "Draft typed while assistant is replying";
  await threadComposer.click();
  await threadComposer.pressSequentially(draftText, { delay: 30 });
  await expect(threadComposer).toContainText(draftText);
  await expect(stopButton).toBeVisible();
  expect(await answer.textContent()).not.toBe(beforeTyping);

  await stopButton.click();
  await expect(stopButton).toBeHidden({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expect(transcript).toContainText("Stopped");

  // The draft typed during streaming must have survived every re-render the
  // stream chunks triggered along the way.
  await expect(threadComposer).toContainText(draftText);

  // Every ChatErrorMessage variant renders a "Resend" button
  // (apps/web/src/components/chat/chat-thread-messages.tsx:329-340);
  // zero of them means the turn ended without a stream error.
  await expect(transcript.getByRole("button", { name: "Resend" })).toHaveCount(
    0,
  );
  await expect(errorBoundary).toHaveCount(0);
});

// Markers recognized by the mock AI adapter (E2E_CREATE_DOCUMENT_MARKER and
// E2E_STREAMED_TOOL_ARGS_MARKER in apps/api/src/dev/register-mock-ai.ts):
// together they make the mock stream a create-document call's arguments as
// about five hundred small deltas over two to three seconds, the densest
// update rate a chat turn produces.
const STREAMED_TOOL_ARGS_PROMPT =
  "Draft it as a document please, streaming the arguments";

test("a streamed tool input does not re-render the page per delta", async ({
  page,
}) => {
  await page.goto("/chat", { waitUntil: "commit" });
  const composer = page.getByRole("textbox", { name: /type your question/iu });
  await expect(composer).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await composer.click();
  await composer.pressSequentially("Start this test thread");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page).toHaveURL(
    /\/chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    { timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS },
  );
  const transcript = page.getByRole("log");
  await expect(transcript.getByRole("button", { name: "Retry" })).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });

  // The second turn streams inside the settled thread route, as in the test
  // above.
  const threadComposer = page.locator(
    '[role="textbox"][contenteditable="true"]',
  );
  await threadComposer.click();
  await threadComposer.pressSequentially(STREAMED_TOOL_ARGS_PROMPT);
  await page.getByRole("button", { name: "Send message" }).click();

  // The whole input arrived: the compiled draft opens in the inspector and
  // the continuation answers. A page that commits once per delta trips the
  // render-storm canary (apps/web/src/lib/render-storm-canary.ts), whose
  // console.error fails this test through the `browserErrors` fixture.
  await expect(
    page.getByRole("textbox", { name: /chat about or edit Mutual NDA/iu }),
  ).toBeVisible({ timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS });
  await expect(
    transcript.getByText("The draft is open in the panel"),
  ).toBeVisible({ timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS });
  await expect(transcript.getByRole("button", { name: "Resend" })).toHaveCount(
    0,
  );
});
