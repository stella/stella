import type { Locator, Page } from "@playwright/test";

import { toChatDecisionPassageHref } from "@stll/api-contract";
import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import type { SafeId } from "@stll/api-contract/safe-id";

import { E2E_API_ORIGIN } from "../helpers/api";
import { decisionParagraphRangePayloads } from "../helpers/decision-paragraph-range-payloads";
import {
  DECISION_READER_BOOT_PATH,
  openMemberDecision,
  openVisitorDecision,
} from "../helpers/decision-reader";
import { installDockedChatHistory } from "../helpers/docked-chat-fixtures";
import {
  dockedChatFileThreadPage,
  dockedChatMessagePage,
} from "../helpers/docked-chat-history";
import { installDockedLegalFixtures } from "../helpers/docked-chat-legal-fixtures";
import { dockedChatLegalPayloads } from "../helpers/docked-chat-legal-payloads";
import { expect, test } from "../helpers/test";

const { decision } = decisionParagraphRangePayloads;

const routeInput = {
  caseNumber: decision.caseNumber,
  country: decision.country,
  court: decision.court,
  decisionId: decision.id,
  language: decision.language,
  languageAlternates: decision.languageAlternates,
  slug: decision.slug,
};
const canonicalPath = createCaseLawDecisionPath(
  createCaseLawDecisionRouteParams(routeInput),
);
const idPath = createCaseLawDecisionPath(
  createCaseLawDecisionRouteParams({ ...routeInput, slug: null }),
);

const installParagraphFixture = async (page: Page) => {
  await installDockedLegalFixtures(page);
  await page.route(
    (url) =>
      url.origin === E2E_API_ORIGIN &&
      (url.pathname === `/v1/case/decisions/${decision.id}` ||
        url.pathname === `/v1/case/decisions/by-slug/${decision.slug}`),
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({ json: decision });
    },
  );
};

test.describe("reader chat decision citations", () => {
  test.use({ locale: "en-US", viewport: { width: 1440, height: 1000 } });

  test("same-decision citations land in the main reader and other decisions reuse one panel chip", async ({
    page,
  }) => {
    await installParagraphFixture(page);
    await installDockedChatHistory(page);
    const otherDecision = {
      ...decision,
      id: dockedChatLegalPayloads.bilingualCzechDecision.id,
      caseNumber: "SYN 2/2026",
      slug: "synthetic-citation-other-decision",
    };
    const citation = (decisionId: SafeId<"caseLawDecision">) =>
      toChatDecisionPassageHref({
        decisionId,
        anchorId: "p-28",
        courtParagraphNumber: 48,
      });
    await page.route(
      (url) =>
        url.origin === E2E_API_ORIGIN &&
        url.pathname === `/v1/chat/decision-threads/${decision.id}`,
      async (route) => {
        await route.fulfill({
          json: { threadId: dockedChatFileThreadPage.threadId },
        });
      },
    );
    await page.route("**/v1/chat/threads/*/messages*", async (route) => {
      await route.fulfill({
        json: {
          ...dockedChatMessagePage,
          messages: dockedChatMessagePage.messages.map((message) => ({
            ...message,
            parts: [
              {
                type: "text",
                content: `[Same decision passage](${citation(decision.id)}) and [Different decision passage](${citation(otherDecision.id)}).`,
              },
            ],
          })),
        } satisfies typeof dockedChatMessagePage,
      });
    });
    await page.route(
      (url) =>
        url.origin === E2E_API_ORIGIN &&
        (url.pathname === `/v1/case/decisions/${otherDecision.id}` ||
          url.pathname === `/v1/case/decisions/by-slug/${otherDecision.slug}`),
      async (route) => {
        await route.fulfill({ json: otherDecision });
      },
    );
    await openMemberDecision(page, {
      bootPath: DECISION_READER_BOOT_PATH,
      path: canonicalPath,
    });
    const panel = page.locator('[data-slot="inspector"]');
    const chips = panel
      .locator('[data-slot="inspector-rail"]')
      .locator('button[draggable="true"]');
    await expect(
      page
        .locator(`[data-decision-citation="${decision.id}"]`)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    // The reader suppresses its floating card while this conversation is
    // visible in the inspector; this scenario starts with the pane closed.
    const hidePane = panel.getByRole("button", {
      name: "Hide pane",
      exact: true,
    });
    if (await hidePane.isVisible()) {
      await hidePane.click();
    }
    await expect(
      panel.getByRole("button", { name: "Show pane", exact: true }),
    ).toBeVisible();
    const chat = page
      .locator('[data-slot="docked-chat-thread"]:visible')
      .first();
    await expect(chat).toContainText("Same decision passage");
    await expect(
      chat.locator(`[data-decision-citation="${decision.id}"]`),
    ).toBeVisible();
    await expect(
      chat.locator(`[data-decision-citation="${otherDecision.id}"]`),
    ).toBeVisible();
    await expect(chips).not.toHaveCount(0);
    const chipCount = await chips.count();
    const mainReader = page.locator(".reader-scroll").first();
    const paragraph = mainReader.locator('[data-anchor="p-28"]');
    await expect(paragraph).not.toBeInViewport();
    await expect(panel.locator("main.reader-paper")).toHaveCount(0);

    const openCitation = async (target: typeof decision) => {
      const trigger = chat.locator(`[data-decision-citation="${target.id}"]`);
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      const popup = page.locator('[data-slot="popover-popup"][data-open]');
      await expect(popup).not.toHaveAttribute("data-ending-style");
      const action = popup.getByRole("link", {
        name: "Open in stella",
        exact: true,
      });
      const targetPath = createCaseLawDecisionPath(
        createCaseLawDecisionRouteParams({
          ...routeInput,
          caseNumber: target.caseNumber,
          decisionId: target.id,
          slug: target.slug,
        }),
      );
      await expect(action).toHaveAttribute("href", `${targetPath}#p-28`);
      await popup
        .getByRole("button", { name: "Open in side panel", exact: true })
        .click();
    };
    const expectLandingMarker = async (target: Locator) => {
      await expect(target).toBeInViewport();
      await expect(target).toHaveAttribute("data-reader-landing");
      await expect
        .poll(async () =>
          target.evaluate((element) => {
            const marker = getComputedStyle(element, "::before");
            return {
              content: marker.content,
              width: marker.width,
              position: marker.position,
              painted:
                marker.backgroundColor !== "transparent" &&
                marker.backgroundColor !== "rgba(0, 0, 0, 0)",
            };
          }),
        )
        .toEqual({
          content: '""',
          width: "2px",
          position: "absolute",
          painted: true,
        });
    };
    await openCitation(decision);
    await expect(panel.locator("main.reader-paper")).toHaveCount(0);
    await expect(chips).toHaveCount(chipCount);
    await expectLandingMarker(paragraph);
    await expect
      .poll(async () => mainReader.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    await mainReader.hover();
    await page.mouse.wheel(0, -100_000);
    await expect(paragraph).not.toBeInViewport();
    await openCitation(decision);
    await expectLandingMarker(paragraph);
    await expect(panel.locator("main.reader-paper")).toHaveCount(0);
    await expect(chips).toHaveCount(chipCount);

    await openCitation(otherDecision);
    await expect(chips).toHaveCount(chipCount + 1);
    const panelParagraph = panel.locator(
      'main.reader-paper [data-anchor="p-28"]',
    );
    await expectLandingMarker(panelParagraph);
    await panel
      .locator('[data-slot="scroll-area-viewport"]')
      .filter({
        has: page.locator("main.reader-paper"),
      })
      .hover();
    await page.mouse.wheel(0, -100_000);
    await expect(panelParagraph).not.toBeInViewport();
    await openCitation(otherDecision);
    await expectLandingMarker(panelParagraph);
    await expect(chips).toHaveCount(chipCount + 1);
    await expect(panel.locator("main.reader-paper")).toHaveCount(1);
  });
});

test.describe("court paragraph deep links", () => {
  test.use({ storageState: { cookies: [], origins: [] }, locale: "en-US" });

  test("canonicalizes the URL, scrolls to court numbers and updates range highlights on hash navigation", async ({
    page,
  }) => {
    await installParagraphFixture(page);
    expect(idPath).not.toBe(canonicalPath);
    await openVisitorDecision(page, {
      bootPath: DECISION_READER_BOOT_PATH,
      path: `${idPath}#par=48-53`,
    });
    await expect(page).toHaveURL(`${canonicalPath}#par=48-53`);

    const reader = page.locator(".reader-scroll");
    const first = reader.locator('[data-anchor="p-28"]');
    const highlights = reader.locator("article [data-reader-landing]");
    await expect(highlights).toHaveCount(6);
    for (const paragraph of await highlights.all()) {
      await expect(paragraph).toHaveClass(/\bbg-accent\b/u);
      await expect(paragraph).toHaveClass(/\btext-accent-foreground\b/u);
    }
    await expect(first).toBeFocused();
    await expect(reader.getByRole("status")).toHaveText(
      "Paragraphs 48-53 highlighted.",
    );
    await expect
      .poll(async () => reader.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect
      .poll(async () =>
        first.evaluate((element) => {
          const viewport = element
            .closest(".reader-scroll")
            ?.getBoundingClientRect();
          const paragraph = element.getBoundingClientRect();
          return (
            viewport !== undefined &&
            paragraph.top >= viewport.top &&
            paragraph.top < viewport.bottom
          );
        }),
      )
      .toBe(true);
    expect(
      await highlights.evaluateAll((elements) =>
        elements.map((element) => element.dataset["anchor"]),
      ),
    ).toEqual(["p-28", "p-29", "p-30", "p-31", "p-32", "p-33"]);
    await expect(reader.locator('[data-anchor="p-48"]')).not.toHaveAttribute(
      "data-reader-landing",
    );

    await page.evaluate(() => {
      window.location.hash = "par=49";
    });
    await expect(highlights).toHaveCount(1);
    await expect(highlights).toHaveAttribute("data-anchor", "p-29");
    await expect(reader.locator('[data-anchor="p-29"]')).toBeFocused();
    await expect(first).not.toHaveClass(/\bbg-accent\b/u);
    await expect(first).not.toHaveAttribute("tabindex");
    await expect(reader.getByRole("status")).toHaveText(
      "Paragraph 49 highlighted.",
    );

    await page.evaluate(() => {
      window.location.hash = "";
    });
    await expect(highlights).toHaveCount(0);
    await expect(reader.getByRole("status")).toHaveCount(0);
    await expect(reader.locator('[data-anchor="p-29"]')).not.toHaveClass(
      /\bbg-accent\b/u,
    );
  });

  for (const { fragment, message } of [
    { fragment: "par=999", message: "Paragraph 999 not found in this text." },
    {
      fragment: "par=48-101",
      message: "Paragraphs 48-101 not found in this text.",
    },
  ]) {
    test(`shows a notice at the top when ${fragment} cannot address court paragraphs`, async ({
      page,
    }) => {
      await installParagraphFixture(page);
      await openVisitorDecision(page, {
        bootPath: DECISION_READER_BOOT_PATH,
        path: `${canonicalPath}#par=48-53`,
      });
      const reader = page.locator(".reader-scroll");
      await expect(reader.locator("article [data-reader-landing]")).toHaveCount(
        6,
      );
      await expect
        .poll(async () => reader.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);

      await page.evaluate((hash) => {
        window.location.hash = hash;
      }, fragment);
      const notice = reader.getByRole("status");
      await expect(notice).toHaveText(message);
      await expect(notice).toBeInViewport();
      await expect(notice).not.toHaveClass(/\bsr-only\b/u);
      await expect(reader.locator("article [data-reader-landing]")).toHaveCount(
        0,
      );
      await expect
        .poll(async () => reader.evaluate((element) => element.scrollTop))
        .toBe(0);
    });
  }
  for (const fragment of ["par=53-48", "par=48a", "par=1-501"]) {
    test(`invalid fragment ${fragment} opens normally without a range notice`, async ({
      page,
    }) => {
      await installParagraphFixture(page);
      await openVisitorDecision(page, {
        bootPath: DECISION_READER_BOOT_PATH,
        path: `${canonicalPath}#${fragment}`,
      });
      await expect(page).toHaveURL(`${canonicalPath}#${fragment}`);
      const reader = page.locator(".reader-scroll");
      await expect(reader.locator('[data-anchor="p-1"]')).toBeInViewport();
      await expect(reader.locator("article [data-reader-landing]")).toHaveCount(
        0,
      );
      await expect(reader.getByRole("status")).toHaveCount(0);

      await page.evaluate(() => {
        window.location.hash = "par=48-53";
      });
      await expect(reader.locator("article [data-reader-landing]")).toHaveCount(
        6,
      );
      await page.evaluate((hash) => {
        window.location.hash = hash;
      }, fragment);
      await expect(page).toHaveURL(`${canonicalPath}#${fragment}`);
      await expect(reader.locator("article [data-reader-landing]")).toHaveCount(
        0,
      );
      await expect(reader.getByRole("status")).toHaveCount(0);
    });
  }

  test("a decision without an AST retains its existing unavailable state", async ({
    page,
  }) => {
    await installParagraphFixture(page);
    await page.route(
      (url) =>
        url.origin === E2E_API_ORIGIN &&
        url.pathname === `/v1/case/decisions/by-slug/${decision.slug}`,
      async (route) => {
        await route.fulfill({
          json: decisionParagraphRangePayloads.unavailable,
        });
      },
    );
    await openVisitorDecision(page, {
      bootPath: DECISION_READER_BOOT_PATH,
      path: `${canonicalPath}#par=48-53`,
    });
    await expect(page).toHaveURL(`${canonicalPath}#par=48-53`);
    await expect(
      page.getByText(
        "The court has not published the decision text, or it is not available here yet.",
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    await expect(page.locator("article [data-reader-landing]")).toHaveCount(0);
    await expect(
      page.getByText("Paragraphs 48-53 not found in this text.", {
        exact: true,
      }),
    ).toHaveCount(0);
  });
});
