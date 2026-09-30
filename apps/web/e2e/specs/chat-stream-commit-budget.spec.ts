import type { StreamChunkKind } from "../../src/features/chat/stream-chunk-commit-budget";
import { STREAM_CHUNK_COMMIT_BUDGET } from "../../src/features/chat/stream-chunk-commit-budget";
import { RENDER_COMMIT_COUNT_GLOBAL } from "../../src/lib/render-storm-canary";
import { EXPECTS_DEV_RUNTIME } from "../helpers/runtime-mode";
import { expect, test } from "../helpers/test";

// Oracle `chat.render.stream-commits-bounded`, on the running app: for every
// kind of chunk the thread page budgets, the mock model streams that kind as
// a few hundred tiny deltas a few milliseconds apart (its marker,
// `mockAiMarker`, read by apps/api/src/dev/mock-ai-stream-kinds.ts), and the
// page's commit rate while the response streams stays within the kind's
// budget. The dev-only render-storm canary counts every commit of the app
// (`RENDER_COMMIT_COUNT_GLOBAL`) and fails any spec on a sustained storm
// through the `browserErrors` fixture. A production build has neither, so
// there the spec does not run.

/**
 * Kinds whose deltas each reach the page as their own commit today: the chat
 * runtime tells its subscribers about every chunk that changes the messages.
 * Each runs as an expected failure under the rule it breaks, so it fails
 * loudly once the page commits at a bounded rate. A subagent's run and its
 * status steps stream inside the server's tool call, so the page sees none
 * of their deltas.
 */
const OVER_BUDGET_TODAY: ReadonlySet<StreamChunkKind> = new Set([
  "reasoning",
  "text",
  "tool-input",
  "tool-output",
]);

const KINDS = Object.keys(STREAM_CHUNK_COMMIT_BUDGET).filter(
  (kind): kind is StreamChunkKind => kind in STREAM_CHUNK_COMMIT_BUDGET,
);

/** A kind's run waits on the user instead of answering: the ask-user card. */
const WAITS_ON_USER = {
  reasoning: false,
  status: false,
  subagent: false,
  text: false,
  "tool-input": true,
  "tool-output": false,
} as const satisfies Record<StreamChunkKind, boolean>;

for (const kind of KINDS) {
  const {
    commitsPerSecond: budget,
    mockAiMarker,
    streams,
  } = STREAM_CHUNK_COMMIT_BUDGET[kind];

  test(`the thread page commits at a bounded rate while ${kind} streams`, async ({
    page,
  }) => {
    test.skip(!EXPECTS_DEV_RUNTIME, "The commit counter is dev-only.");
    test.fail(
      OVER_BUDGET_TODAY.has(kind),
      "The page commits once per streamed delta of this kind.",
    );

    await page.goto("/chat", { waitUntil: "commit" });
    const composer = page.getByRole("textbox", {
      name: /type your question/iu,
    });
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.click();
    await composer.pressSequentially("Start this test thread");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page).toHaveURL(
      /\/chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
      { timeout: 30_000 },
    );
    const transcript = page.getByRole("log");
    await expect(transcript.getByRole("button", { name: "Retry" })).toBeVisible(
      { timeout: 30_000 },
    );

    // The measured turn streams inside the settled thread route.
    const threadComposer = page.locator(
      '[role="textbox"][contenteditable="true"]',
    );
    await threadComposer.click();
    await threadComposer.pressSequentially(mockAiMarker);

    const readCommits = async () =>
      await page.evaluate((key) => {
        const counted: unknown = Reflect.get(globalThis, key);
        return typeof counted === "number" ? counted : 0;
      }, RENDER_COMMIT_COUNT_GLOBAL);
    const commitsBefore = await readCommits();
    const startedAt = Date.now();
    await page.getByRole("button", { name: "Send message" }).click();

    const stop = page.getByRole("button", { name: "Stop" });
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await expect(stop).toHaveCount(0, { timeout: 60_000 });
    const commits = (await readCommits()) - commitsBefore;
    const seconds = (Date.now() - startedAt) / 1000;

    if (WAITS_ON_USER[kind]) {
      await expect(
        transcript.getByRole("button", { name: "Submit answers" }),
      ).toBeVisible({ timeout: 30_000 });
    } else {
      await expect(
        transcript.getByRole("button", { name: "Resend" }),
      ).toHaveCount(0);
    }
    expect(
      commits / seconds,
      `chat.render.stream-commits-bounded: ${String(commits)} commits in ${seconds.toFixed(1)} s while ${streams} streamed`,
    ).toBeLessThanOrEqual(budget);
  });
}
