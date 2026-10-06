import type { Page } from "@playwright/test";

import type { DecisionAnalysis } from "@stll/legal-ast/analysis";

import messages from "../../src/i18n/langs/en.json" with { type: "json" };
import {
  DOCKED_CHAT_LEGAL_ROUTES,
  installDockedLegalFixtures,
} from "../helpers/docked-chat-legal-fixtures";
import { dockedChatLegalPayloads } from "../helpers/docked-chat-legal-payloads";
import { expect, test } from "../helpers/test";

const READER_SENTENCE =
  "Synthetic reader contract explains the contract and resolves the contract claim.";
const GEOMETRY_TOLERANCE = 1;

const installReaderText = async (page: Page) => {
  await installDockedLegalFixtures(page);
  const decision = {
    ...dockedChatLegalPayloads.decision,
    fulltext: READER_SENTENCE,
  };
  await page.route(
    `**/v1/case/decisions/${decision.id}`,
    async (route) => await route.fulfill({ json: decision }),
  );
  await page.route(
    `**/v1/case/decisions/by-slug/${decision.slug}*`,
    async (route) => await route.fulfill({ json: decision }),
  );
  await page.route(
    `**/v1/case/decisions/${decision.id}/analysis`,
    async (route) =>
      await route.fulfill({
        json: {
          status: "done",
          analysis: {
            version: 2,
            generatedAt: "2026-01-01T00:00:00.000Z",
            model: "synthetic",
            inputFingerprint: "f".repeat(64),
            tree: [],
          } satisfies DecisionAnalysis,
        },
      }),
  );
};

const activeMatchOffset = async (page: Page) =>
  await page.evaluate(() => {
    for (const [name, highlight] of CSS.highlights) {
      if (!name.startsWith("stella-inspector-find-active-")) {
        continue;
      }
      const range = highlight.values().next().value;
      return range?.startOffset ?? null;
    }
    return null;
  });

for (const colorScheme of ["light", "dark"] as const) {
  test(`reader find overlays its text and owns match navigation (${colorScheme})`, async ({
    page,
    browserErrors,
  }) => {
    await page.emulateMedia({ colorScheme });
    await installReaderText(page);
    await page.goto("/chat", { waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[contenteditable="true"]:visible').first(),
    ).toBeVisible();
    await page.evaluate(
      (path) => history.pushState(null, "", path),
      DOCKED_CHAT_LEGAL_ROUTES.decision.path,
    );
    await expect(
      page.getByText(READER_SENTENCE, { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: messages.inspector.moveToSide, exact: true })
      .click();
    const pane = page.locator('[data-slot="inspector"]');
    const sentence = pane.getByText(READER_SENTENCE, { exact: true });
    await expect(sentence).toBeVisible();
    const before = await sentence.evaluate(
      (element) => element.getBoundingClientRect().y,
    );
    await sentence.click();
    await page.keyboard.press("ControlOrMeta+f");
    const bar = pane.locator('[data-slot="reader-find-bar"]');
    const input = bar.getByRole("searchbox");
    await expect(input).toBeFocused();
    await input.fill("contract");
    await expect(bar).toContainText("1 / 3");
    const after = await sentence.evaluate(
      (element) => element.getBoundingClientRect().y,
    );
    expect(Math.abs(after - before)).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
    const headerClose = pane.getByRole("button", {
      name: messages.common.close,
      exact: true,
    });
    const findClose = bar.getByRole("button", {
      name: messages.folio.findReplace.close,
      exact: true,
    });
    const headerBox = await headerClose.boundingBox();
    const findBox = await findClose.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(findBox).not.toBeNull();
    if (headerBox === null || findBox === null) {
      return;
    }
    expect(Math.abs(headerBox.x - findBox.x)).toBeLessThanOrEqual(
      GEOMETRY_TOLERANCE,
    );
    expect(findBox.width).toBe(headerBox.width);
    expect(findBox.height).toBe(headerBox.height);
    const firstMatch = await activeMatchOffset(page);
    expect(firstMatch).not.toBeNull();
    await input.press("Enter");
    await expect(bar).toContainText("2 / 3");
    expect(await activeMatchOffset(page)).not.toBe(firstMatch);
    await input.press("Shift+Enter");
    await expect(bar).toContainText("1 / 3");
    expect(await activeMatchOffset(page)).toBe(firstMatch);
    await input.press("Escape");
    await expect(bar).toHaveCount(0);
    expect(await activeMatchOffset(page)).toBeNull();
    expect(
      await sentence.evaluate((element) => element.getBoundingClientRect().y),
    ).toBe(before);
    browserErrors.assertEmpty("reader find overlay");
  });
}
