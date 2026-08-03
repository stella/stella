import { expect, test } from "../helpers/test";

// The seeded e2e user (test@stella.dev) is an org owner whose org has NO
// usage_entitlements row — the dark-launch default every production org
// starts in. We deliberately do not create an entitlement here: regressions
// that only surface in that default state must fail this spec.
test("chat composer sends a message and renders the assistant reply", async ({
  page,
}) => {
  // Keep the sticky-turn canary independent of the runner's default viewport.
  // The transcript must have enough vertical overflow to cross the sticky
  // sentinel; otherwise scrollTop is clamped before the state can become stuck.
  await page.setViewportSize({ height: 420, width: 960 });

  // A route is ready when its UI is ready, not when every cold Vite resource
  // has fired the browser load event. Commit the document, then synchronize on
  // the composer below.
  await page.goto("/chat", { waitUntil: "commit" });

  // Route error boundary heading (apps/web/src/components/route-components.tsx,
  // title routeError.title). Checked after every step below; declared
  // once so the assertions read the same way each time.
  const errorBoundary = page.getByRole("heading", {
    name: "This page couldn’t be opened",
  });
  await expect(errorBoundary).toHaveCount(0);

  // The composer's contenteditable carries an explicit role and
  // aria-label (chat-editor-provider editorProps); the name filter
  // keeps the locator unique even when other textbox-role editors
  // (e.g. folio) are mounted.
  const composer = page.getByRole("textbox", {
    name: /type your question/iu,
  });
  // First locator after navigation: a cold Vite dev server compiles the
  // chat route chunk on demand, which can exceed the default 10s expect
  // timeout on a fresh CI runner (see playwright.config.ts).
  await expect(composer).toBeVisible({ timeout: 30_000 });

  const messageText =
    "Hello from the stella e2e chat spec. This deliberately long prompt wraps across several lines so the sticky user header has a different natural and compact height. ".repeat(
      4,
    );
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

  const transcript = page.getByRole("log");
  // First assertion on the thread route: its lazy chunk cold-compiles
  // on a fresh dev server, so allow the same headroom as the composer.
  await expect(transcript.getByText(messageText)).toBeVisible({
    timeout: 30_000,
  });

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

  // A populated thread uses the compact composer. Its controls share the
  // editor row; regressing to a second action row creates a large empty band
  // under one-line prompts.
  const compactComposerHeight = await composer.evaluate((textbox) => {
    const editor = textbox.closest(".chat-editor");
    const surface = editor?.parentElement?.parentElement;
    if (!(surface instanceof HTMLElement)) {
      throw new Error("Compact composer is missing its surface");
    }
    return surface.getBoundingClientRect().height;
  });
  expect(compactComposerHeight).toBeLessThanOrEqual(48);

  const followups = page.getByRole("group", {
    name: /suggested follow-up prompts/iu,
  });
  await expect(followups).toBeVisible({ timeout: 30_000 });
  const typography = await followups
    .getByRole("button")
    .first()
    .evaluate((chip) => {
      const textbox = document.querySelector(
        '[role="textbox"][contenteditable="true"]',
      );
      if (!(textbox instanceof HTMLElement)) {
        throw new Error("Chat composer textbox is missing");
      }
      return {
        chip: Number.parseFloat(getComputedStyle(chip).fontSize),
        composer: Number.parseFloat(getComputedStyle(textbox).fontSize),
      };
    });
  expect(typography.chip).toBeLessThan(typography.composer);

  // Pin the long user prompt at its sticky boundary. Compaction must remain
  // visual only: changing the turn's in-flow height makes Chrome scroll
  // anchoring move the sentinel back across that boundary, causing the
  // header to expand/collapse and React to commit indefinitely.
  const stickyHeader = transcript.locator("[data-stuck]").filter({
    hasText: messageText,
  });
  await expect(stickyHeader).toHaveCount(1);
  const availableScroll = await stickyHeader.evaluate((header) => {
    const viewport = header.closest('[data-slot="scroll-area-viewport"]');
    if (!(viewport instanceof HTMLElement)) {
      throw new Error("Sticky chat header is missing its scroll viewport");
    }
    return viewport.scrollHeight - viewport.clientHeight;
  });
  expect(availableScroll).toBeGreaterThan(0);
  await stickyHeader.evaluate((header) => {
    const viewport = header.closest('[data-slot="scroll-area-viewport"]');
    const turn = header.closest("[data-chat-turn-id]");
    if (!(viewport instanceof HTMLElement) || !(turn instanceof HTMLElement)) {
      throw new Error("Sticky chat turn is missing its scroll boundary");
    }
    const sentinel = turn.querySelector<HTMLElement>('[aria-hidden="true"]');
    if (!sentinel) {
      throw new Error("Sticky chat turn is missing its sentinel");
    }
    viewport.scrollTop +=
      sentinel.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top +
      1;
  });
  await expect(stickyHeader).toHaveAttribute("data-stuck", "true");

  const geometrySamples = await stickyHeader.evaluate(
    async (
      header,
    ): Promise<
      { headerHeight: number; scrollHeight: number; scrollTop: number }[]
    > => {
      const viewport = header.closest('[data-slot="scroll-area-viewport"]');
      if (!(viewport instanceof HTMLElement)) {
        throw new Error("Sticky chat header is missing its scroll viewport");
      }
      const samples: {
        headerHeight: number;
        scrollHeight: number;
        scrollTop: number;
      }[] = [];
      await new Promise<void>((resolve) => {
        let framesRemaining = 120;
        const sampleFrame = () => {
          samples.push({
            headerHeight: header.getBoundingClientRect().height,
            scrollHeight: viewport.scrollHeight,
            scrollTop: viewport.scrollTop,
          });
          framesRemaining -= 1;
          if (framesRemaining === 0) {
            resolve();
            return;
          }
          requestAnimationFrame(sampleFrame);
        };
        requestAnimationFrame(sampleFrame);
      });
      return samples;
    },
  );
  expect(
    new Set(geometrySamples.map(({ headerHeight }) => headerHeight)).size,
  ).toBe(1);
  expect(
    new Set(geometrySamples.map(({ scrollHeight }) => scrollHeight)).size,
  ).toBe(1);
  expect(new Set(geometrySamples.map(({ scrollTop }) => scrollTop)).size).toBe(
    1,
  );
});
