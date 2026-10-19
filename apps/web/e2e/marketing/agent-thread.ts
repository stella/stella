// Shared by the landing screenshot spec and the video recorder: both film the
// seeded agent thread (apps/api/scripts/seed-marketing-agent-thread.ts) and
// must wait on, and frame, the same finished state.
// The e2e tsconfig is node-only; the evaluate callbacks below run in the
// browser, so pull in the DOM lib for their globals.
/// <reference lib="dom" />
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { MARKETING_LOCALE_MARKERS } from "@stll/playwright-tools/marketing-locales";
import type { MarketingLocale } from "@stll/playwright-tools/marketing-locales";

import { uiText } from "./ui-text";

// The seed writes the thread from the same markers
// (apps/api/scripts/seed-marketing-agent-thread.ts); a drift fails the waits
// below loudly.

/**
 * The two inline citation chips in the final answer, which the video clicks.
 * `bodyMarker` is the cited file name, which the seeded review extract prints
 * in its body, so the inspector preview can be told apart per document.
 */
export const marketingAgentCitedSources = (locale: MarketingLocale) => {
  const toSource = ({
    chipLabel,
    fileName,
  }: {
    chipLabel: string;
    fileName: string;
  }) => ({
    chipLabel,
    bodyMarker: fileName.replace(/\.docx$/u, ""),
    label: fileName,
  });
  const [first, second] = MARKETING_LOCALE_MARKERS[locale].agent.citedSources;
  return [toSource(first), toSource(second)] as const;
};

// `Array.isArray` narrows `unknown` to `any[]`; this keeps elements `unknown`.
const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

/** The seeded thread's id in a `/v1/chat/threads` response, by title. */
export const getMarketingAgentThreadId = (
  payload: unknown,
  locale: MarketingLocale,
): string | undefined => {
  const { threadTitle } = MARKETING_LOCALE_MARKERS[locale].agent;
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("workspaces" in payload) ||
    !isUnknownArray(payload.workspaces)
  ) {
    return undefined;
  }

  for (const workspace of payload.workspaces) {
    if (
      typeof workspace !== "object" ||
      workspace === null ||
      !("threads" in workspace) ||
      !isUnknownArray(workspace.threads)
    ) {
      continue;
    }
    for (const thread of workspace.threads) {
      if (
        typeof thread === "object" &&
        thread !== null &&
        "id" in thread &&
        typeof thread.id === "string" &&
        "title" in thread &&
        thread.title === threadTitle
      ) {
        return thread.id;
      }
    }
  }

  return undefined;
};

// The same tokens e2e/visual-design-capture.flow.ts compares.
const THEME_TOKENS = ["--foreground", "--border", "--chart-1"];

/**
 * Wait until the whole thread has painted: the cited table, the inline chips,
 * the generated view's guest page (content, fonts, final height and the host
 * theme), and the pinned recap. Then scroll the transcript to the final turn.
 * With `frameBottom` (the screenshot clip's bottom edge, in page pixels), also
 * require the whole view, down to its bordered frame's bottom edge, to sit
 * above it, so a taller view or a moved anchor fails here instead of shipping
 * a shot that cuts the matrix or anything under it.
 */
export const settleMarketingAgentThread = async (
  page: Page,
  { frameBottom, locale }: { frameBottom?: number; locale: MarketingLocale },
) => {
  const markers = MARKETING_LOCALE_MARKERS[locale].agent;
  const [firstQuestion, secondQuestion, lastQuestion] = markers.questions;
  const transcript = page
    .getByRole("log")
    .locator('[data-slot="scroll-area-viewport"]');
  await expect(transcript).toBeVisible();
  // A complete three-turn conversation is required, even though the final
  // capture anchors the last turn. An empty or truncated thread cannot pass
  // merely because it contains a table and a generated view.
  const messages = transcript.locator("[data-chat-message-id]");
  await expect(messages).toHaveCount(6);
  await expect(messages.nth(0)).toContainText(firstQuestion);
  await expect(messages.nth(2)).toContainText(secondQuestion);
  await expect(messages.nth(4)).toContainText(lastQuestion);
  for (const answerIndex of [1, 3, 5]) {
    await expect(messages.nth(answerIndex)).not.toHaveText(/^\s*$/u);
  }
  await expect(
    page.getByText(uiText(locale, "chat.greeting"), { exact: true }),
  ).toHaveCount(0);
  // First answer: a header and one row per counterparty. Its row count comes
  // from the seeded data room, which the generated view's matrix must match.
  const answerTable = transcript.locator("table").first();
  await expect(answerTable.locator("tbody tr").first()).toBeVisible();
  const counterpartyCount = await answerTable.locator("tbody tr").count();
  for (const { chipLabel } of markers.citedSources) {
    await expect(transcript.getByText(chipLabel).first()).toBeVisible();
  }

  const selector = `iframe[title="${markers.viewTitle}"]`;
  const outer = page.locator(selector);
  await expect(outer).toBeVisible();
  const guest = page.frameLocator(selector).frameLocator("iframe");
  await expect(guest.locator("#matrix-body tr")).toHaveCount(counterpartyCount);
  await guest.locator("html").evaluate(async () => {
    await document.fonts.ready;
  });
  // The frame takes the guest's reported height after it renders; a shot
  // taken before then crops the matrix or leaves blank space under it.
  await expect
    .poll(
      async () => {
        const contentHeight = await guest
          .locator("html")
          .evaluate((element) => element.scrollHeight);
        const frameHeight = await outer.evaluate(
          (element) => element.getBoundingClientRect().height,
        );
        return Math.abs(contentHeight - frameHeight) <= 1;
      },
      { message: "generated view frame matches its content height" },
    )
    .toBe(true);
  const hostTokens = await page
    .locator("html")
    .evaluate(
      (element, names) =>
        names.map((name) =>
          getComputedStyle(element).getPropertyValue(name).trim(),
        ),
      THEME_TOKENS,
    );
  await expect
    .poll(
      async () =>
        guest
          .locator("html")
          .evaluate(
            (element, names) =>
              names.map((name) =>
                getComputedStyle(element).getPropertyValue(name).trim(),
              ),
            THEME_TOKENS,
          ),
      { message: "generated view uses the host theme" },
    )
    .toEqual(hostTokens);
  await expect(
    page.getByText(markers.recapPrefix, { exact: false }).first(),
  ).toBeVisible();

  await anchorMarketingAgentFinalTurn(page, locale);
  if (frameBottom !== undefined) {
    // The iframe's parent is the view's bordered frame; boundingBox reports
    // nested-frame elements in the host page's pixels, so the guest's last
    // row is checked on the same scale.
    const viewFrame = outer.locator("xpath=..");
    const lastRow = guest.locator("#matrix-body tr").last();
    for (const [name, part] of [
      ["the matrix's last row", lastRow],
      ["the generated view's frame", viewFrame],
    ] as const) {
      await expect
        .poll(
          async () => {
            const box = await part.boundingBox();
            return (
              box !== null && box.y >= 0 && box.y + box.height <= frameBottom
            );
          },
          {
            message: `${name} ends above the ${String(frameBottom)}px frame edge`,
          },
        )
        .toBe(true);
    }
  }
};

/**
 * Scroll the transcript so the final turn starts at its top: the frame then
 * shows the final question, the cited lead-in and the generated view, instead
 * of wherever stick-to-bottom left it. The turn's own top is measured, not the
 * question's: on the chat page the question is a sticky header whose box
 * reports its pinned position. Scrolling up releases the bottom lock, so the
 * position holds once set. Call again after anything that reflows the chat
 * (an inspector closing).
 */
export const anchorMarketingAgentFinalTurn = async (
  page: Page,
  locale: MarketingLocale,
) => {
  const markers = MARKETING_LOCALE_MARKERS[locale].agent;
  const transcript = page
    .getByRole("log")
    .locator('[data-slot="scroll-area-viewport"]');
  const finalQuestion = transcript
    .locator("[data-chat-message-id]")
    .filter({ hasText: markers.questions[2] })
    .last();
  await expect(finalQuestion).toBeVisible();
  const anchorGap = 8;
  // Distance from the turn's top to the viewport's top, or null once the
  // transcript cannot scroll further (a short final turn on a tall viewport).
  const misalignment = async () =>
    finalQuestion.evaluate((element, gap) => {
      const viewport = element.closest('[data-slot="scroll-area-viewport"]');
      if (viewport === null) {
        throw new Error("The agent thread has no transcript scroll viewport");
      }
      const turn = element.closest("section") ?? element;
      const distance =
        turn.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top -
        gap;
      const atEnd =
        viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 1;
      return distance > 0 && atEnd ? 0 : distance;
    }, anchorGap);
  await expect
    .poll(
      async () => {
        const distance = await misalignment();
        if (Math.abs(distance) > 1) {
          await finalQuestion.evaluate((element, delta) => {
            const viewport = element.closest(
              '[data-slot="scroll-area-viewport"]',
            );
            if (viewport !== null) {
              viewport.scrollTop += delta;
            }
          }, distance);
        }
        return Math.abs(await misalignment());
      },
      { message: "final turn anchored at the transcript top" },
    )
    .toBeLessThanOrEqual(1);
  for (const { chipLabel } of markers.citedSources) {
    await expect(transcript.getByText(chipLabel).last()).toBeInViewport();
  }
};
