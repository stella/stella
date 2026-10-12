// Shared by the landing screenshot spec and the video recorder: both film the
// seeded agent thread (apps/api/scripts/seed-marketing-agent-thread.ts) and
// must wait on, and frame, the same finished state.
// The e2e tsconfig is node-only; the evaluate callbacks below run in the
// browser, so pull in the DOM lib for their globals.
/// <reference lib="dom" />
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

// Keep in sync with seed-marketing-agent-thread.ts (MARKETING_AGENT_THREAD_TITLE
// and MARKETING_AGENT_QUESTIONS). A drift fails the waits below loudly.
export const MARKETING_AGENT_THREAD_TITLE =
  "Project Atlas · Change-of-control review";
export const MARKETING_AGENT_FIRST_QUESTION =
  "Which agreements in the Project Atlas data room carry change-of-control risk?";
const MARKETING_AGENT_LAST_QUESTION =
  "Turn this into a view I can take to the partner meeting.";
// The recap the seed pins on the thread (no model call), shown under the last
// answer once the reopened thread counts as a revisit.
const MARKETING_AGENT_RECAP_PREFIX =
  "You mapped change-of-control exposure across the Project Atlas data room";

/**
 * The two inline citation chips in the final answer, which the video clicks.
 * `bodyMarker` is the cited file name, which the seeded review extract prints
 * in its body, so the inspector preview can be told apart per document.
 */
export const MARKETING_AGENT_CITED_SOURCES = [
  {
    chipLabel: "Delta Logistics · Customer Contract 2019",
    bodyMarker: "Delta_Logistics_Customer_Contract_2019",
    label: "Delta_Logistics_Customer_Contract_2019.docx",
  },
  {
    chipLabel: "Helios Energy · Loan Agreement 2023",
    bodyMarker: "Helios_Energy_Loan_Agreement_2023",
    label: "Helios_Energy_Loan_Agreement_2023.docx",
  },
] as const;

// The seed stores exactly this page; reading it here keeps the frame title and
// row count in step with what the chat renders.
const exposureView = v.parse(
  v.object({
    title: v.string(),
    data: v.object({ counterparties: v.array(v.unknown()) }),
  }),
  JSON.parse(
    readFileSync(
      new URL(
        "../../../api/src/handlers/visual-sandbox/fixtures/showcase/change-of-control-exposure.json",
        import.meta.url,
      ),
      "utf-8",
    ),
  ),
);

// `Array.isArray` narrows `unknown` to `any[]`; this keeps elements `unknown`.
const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

/** The seeded thread's id in a `/v1/chat/threads` response, by title. */
export const getMarketingAgentThreadId = (
  payload: unknown,
): string | undefined => {
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
        thread.title === MARKETING_AGENT_THREAD_TITLE
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
 * require the matrix's last row to sit wholly above it, so a taller view or a
 * moved anchor fails here instead of shipping a shot that cuts the table.
 */
export const settleMarketingAgentThread = async (
  page: Page,
  { frameBottom }: { frameBottom?: number } = {},
) => {
  const transcript = page
    .getByRole("log")
    .locator('[data-slot="scroll-area-viewport"]');
  await expect(transcript).toBeVisible();
  // First answer: one table row per counterparty plus the header.
  await expect(transcript.locator("table tr")).toHaveCount(
    exposureView.data.counterparties.length + 1,
  );
  for (const { chipLabel } of MARKETING_AGENT_CITED_SOURCES) {
    await expect(transcript.getByText(chipLabel).first()).toBeVisible();
  }

  const selector = `iframe[title="${exposureView.title}"]`;
  const outer = page.locator(selector);
  await expect(outer).toBeVisible();
  const guest = page.frameLocator(selector).frameLocator("iframe");
  await expect(guest.locator("#matrix-body tr")).toHaveCount(
    exposureView.data.counterparties.length,
  );
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
    page.getByText(MARKETING_AGENT_RECAP_PREFIX, { exact: false }).first(),
  ).toBeVisible();

  await anchorMarketingAgentFinalTurn(page);
  if (frameBottom !== undefined) {
    // boundingBox reports nested-frame elements in the host page's pixels.
    const lastRow = guest.locator("#matrix-body tr").last();
    await expect
      .poll(
        async () => {
          const box = await lastRow.boundingBox();
          return (
            box !== null && box.y >= 0 && box.y + box.height <= frameBottom
          );
        },
        {
          message: `the matrix's last row ends above the ${String(frameBottom)}px frame edge`,
        },
      )
      .toBe(true);
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
export const anchorMarketingAgentFinalTurn = async (page: Page) => {
  const transcript = page
    .getByRole("log")
    .locator('[data-slot="scroll-area-viewport"]');
  const finalQuestion = transcript
    .locator("[data-chat-message-id]")
    .filter({ hasText: MARKETING_AGENT_LAST_QUESTION })
    .last();
  await expect(finalQuestion).toBeVisible();
  const anchorGap = 12;
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
  for (const { chipLabel } of MARKETING_AGENT_CITED_SOURCES) {
    await expect(transcript.getByText(chipLabel).last()).toBeInViewport();
  }
};
