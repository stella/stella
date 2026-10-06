import messages from "../../src/i18n/langs/en.json" with { type: "json" };
import {
  DOCKED_CHAT_LEGAL_ROUTES,
  installDockedLegalFixtures,
} from "../helpers/docked-chat-legal-fixtures";
import {
  delayFreshThreadRead,
  expectComposerVisibleWhilePending,
  expectComposerPreserved,
  expectComposerScope,
  installPersistenceHistory,
  PERSISTENCE_THREAD_ID,
  rememberComposer,
  resetFromCompactAnswer,
} from "../helpers/new-chat-persistence";
import { expect, test } from "../helpers/test";

for (const colorScheme of ["light", "dark"] as const) {
  test(`full New chat retains its composer and settings (${colorScheme})`, async ({
    page,
    browserErrors,
  }) => {
    await page.emulateMedia({ colorScheme });
    const matter = await installPersistenceHistory(page);
    await page.goto(`/chat/${PERSISTENCE_THREAD_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByText("Saved geometry test answer.", { exact: true }),
    ).toBeVisible();
    await expectComposerScope(page, matter.name);
    const composer = await rememberComposer(page);
    await page
      .getByRole("button", { name: messages.chat.newChat, exact: true })
      .first()
      .click();
    await page.waitForURL(
      (url) =>
        /^\/chat\/[0-9a-f-]{36}$/u.test(url.pathname) &&
        !url.pathname.endsWith(PERSISTENCE_THREAD_ID),
    );
    await expect(
      page.getByText("Saved geometry test answer.", { exact: true }),
    ).toHaveCount(0);
    await expectComposerPreserved(composer);
    await expectComposerScope(page, matter.name);
    browserErrors.assertEmpty("full New chat persistence");
  });

  test(`sidebar landing retains a visible composer while its draft loads (${colorScheme})`, async ({
    page,
    browserErrors,
  }) => {
    await page.emulateMedia({ colorScheme });
    const delay = delayFreshThreadRead();
    const matter = await installPersistenceHistory(page, {
      onFreshRead: delay.onFreshRead,
    });
    await page.goto(`/chat/${PERSISTENCE_THREAD_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByText("Saved geometry test answer.", { exact: true }),
    ).toBeVisible();
    const composer = await rememberComposer(page);
    await page.getByRole("link", { name: "Chat", exact: true }).first().click();
    const navigation = page.waitForURL((url) => url.pathname === "/chat");
    const phase = await Promise.race([
      delay.requested.then(() => "requested" as const),
      navigation.then(() => "settled" as const),
    ]);
    if (phase === "requested") {
      await delay.waitForPendingBoundary();
      await expectComposerVisibleWhilePending(composer);
      delay.release();
    }
    await page.waitForURL((url) => url.pathname === "/chat");
    await expect(
      page.getByText("Saved geometry test answer.", { exact: true }),
    ).toHaveCount(0);
    await expectComposerPreserved(composer);
    await expectComposerScope(page, matter.name);
    browserErrors.assertEmpty("sidebar draft loading persistence");
  });

  test(`cold matter-scoped New chat preloads its exact draft (${colorScheme})`, async ({
    page,
    browserErrors,
  }) => {
    await page.emulateMedia({ colorScheme });
    const matter = await installPersistenceHistory(page);
    await page.goto(`/chat/workspaces/${matter.id}/new`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith(`/chat/workspaces/${matter.id}/`) &&
        !url.pathname.endsWith("/new"),
    );
    await expect(
      page.locator('[contenteditable="true"]:visible').first(),
    ).toBeVisible();
    await expectComposerScope(page, matter.name);
    browserErrors.assertEmpty("cold matter draft preload");
  });

  test(`compact reader New chat retains its composer and decision scope (${colorScheme})`, async ({
    page,
    browserErrors,
  }) => {
    await page.emulateMedia({ colorScheme });
    const matter = await installPersistenceHistory(page);
    await installDockedLegalFixtures(page);
    await page.goto(`/chat/${PERSISTENCE_THREAD_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByText("Saved geometry test answer.", { exact: true }),
    ).toBeVisible();
    await page.unroute("**/v1/chat/threads/*/messages*");
    await installPersistenceHistory(page, {
      historyPath: DOCKED_CHAT_LEGAL_ROUTES.decision.path,
    });
    await page.evaluate(
      (path) => history.pushState(null, "", path),
      DOCKED_CHAT_LEGAL_ROUTES.decision.path,
    );
    const card = page.locator('[data-slot="docked-chat-thread"]:visible');
    await expect(card).toContainText("Saved geometry test answer.");
    await expectComposerScope(page, matter.name);
    const composer = await rememberComposer(page);
    const path = new URL(page.url()).pathname;
    await resetFromCompactAnswer(page, card);
    await expectComposerPreserved(composer);
    await expectComposerScope(page, matter.name);
    expect(new URL(page.url()).pathname).toBe(path);
    await expect(
      page.getByText("SYN 1/2026", { exact: true }).first(),
    ).toBeVisible();
    browserErrors.assertEmpty("compact New chat persistence");
  });
}
