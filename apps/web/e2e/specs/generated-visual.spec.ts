import * as v from "valibot";

import {
  GENERATED_VISUAL_MIME_TYPE,
  GENERATED_VISUAL_URI_PREFIX,
  generatedVisualPageSchema,
  generatedVisualPartSchema,
} from "@stll/api-contract/generated-visual";
import { VISUAL_PREVIEW_TOOL_NAME } from "@stll/api-contract/visual-preview";

import { installDockedChatHistory } from "../helpers/docked-chat-fixtures";
import { dockedChatMessagePage } from "../helpers/docked-chat-history";
import {
  DOCKED_CHAT_LEGAL_ROUTES,
  installDockedLegalFixtures,
} from "../helpers/docked-chat-legal-fixtures";
import { expect, test } from "../helpers/test";

const threadId = "019a0000-0000-7000-8000-000000000001";
const fileId = "019a0000-0000-7000-8000-000000000003";
const externalUrl = "https://example.test/decision?language=cs&year=2026";
const title = "Court timeline";
const visual = v.parse(generatedVisualPageSchema, {
  title,
  html: `<section class="stella-card"><button id="drill">Court year</button><button id="internal">Open decision</button><a href="${externalUrl}">Decision source</a></section><script>const bucket=stella.data.courtYear.buckets[0];document.querySelector('#drill').addEventListener('click',()=>stella.drill({court:bucket.court,year:bucket.year}));document.querySelector('#internal').addEventListener('click',()=>stella.openDecision('decision'));stella.drill({court:bucket.court,year:bucket.year});stella.openDecision('decision');document.querySelector('a').click();document.body.dataset.initialActions='sent';stella.ready();</script>`,
  data: { courtYear: { buckets: [{ court: "CZ:ns", year: 2026 }] } },
  links: [{ id: "decision", decisionId: DOCKED_CHAT_LEGAL_ROUTES.decision.id }],
  literalLinks: [externalUrl],
});
const part = v.parse(generatedVisualPartSchema, {
  type: "ui-resource",
  resource: {
    uri: `${GENERATED_VISUAL_URI_PREFIX}${fileId}`,
    mimeType: GENERATED_VISUAL_MIME_TYPE,
    text: title,
  },
  toolCallId: "visual-render-fixture",
  toolName: VISUAL_PREVIEW_TOOL_NAME,
});

test("generated view activates, reloads and offers user-controlled chat actions", async ({
  page,
  context,
}) => {
  await installDockedChatHistory(page);
  await installDockedLegalFixtures(page);
  await page.route("**/v1/chat/threads/*/messages*", async (route) => {
    await route.fulfill({
      json: {
        ...dockedChatMessagePage,
        messages: [
          {
            id: "019a0000-0000-7000-8000-000000000002",
            role: "assistant",
            createdAt: "2026-01-01T00:00:00.000Z",
            parts: [part],
          },
        ],
      },
    });
  });
  let reads = 0;
  await page.route(`**/v1/user-files/${fileId}/visual`, async (route) => {
    reads += 1;
    await route.fulfill({
      json: visual,
      headers: { "cache-control": "private, no-store" },
    });
  });
  await context.route(externalUrl, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<p>Decision source</p>",
    });
  });
  const sends: string[] = [];
  await page.route(/\/v1\/chat\/?(?:\?|$)/u, async (route) => {
    if (route.request().method() === "POST") {
      sends.push(route.request().url());
      await route.fulfill({
        status: 503,
        json: { message: "This fixture does not execute model requests" },
      });
      return;
    }
    await route.continue();
  });
  const popups: string[] = [];
  page.on("popup", (popup) => popups.push(popup.url()));
  await page.goto(`/chat/${threadId}`, { waitUntil: "commit" });
  const outer = page.locator(`iframe[title="${title}"]`);
  await expect(outer).toHaveAttribute("sandbox", "allow-scripts");
  await expect(outer).toHaveAttribute("inert", "");
  const guest = page
    .frameLocator(`iframe[title="${title}"]`)
    .frameLocator("iframe");
  await expect(guest.locator("body")).toHaveAttribute(
    "data-initial-actions",
    "sent",
  );
  const composer = page.locator('[role="textbox"][contenteditable="true"]');
  await expect(composer.locator('[data-source="prompt"]')).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/chat/${threadId}$`, "u"));
  expect(popups).toEqual([]);
  const card = outer.locator("xpath=ancestor::section[1]");
  await card
    .getByRole("button")
    .first()
    .evaluate((element) => {
      if (element instanceof HTMLElement) {
        element.click();
      }
    });
  await expect(outer).toHaveAttribute("inert", "");
  await card.getByRole("button").first().click();
  await expect(outer).not.toHaveAttribute("inert", "");
  await expect(outer).toBeFocused();
  const initialSrc = await outer.getAttribute("src");
  await outer.evaluate((element) => {
    if (element instanceof HTMLIFrameElement) {
      element.setAttribute("src", element.src);
    }
  });
  await expect(outer).not.toHaveAttribute("src", initialSrc ?? "");
  await expect(guest.locator("body")).toHaveAttribute(
    "data-initial-actions",
    "sent",
  );
  await expect(outer).toHaveAttribute("inert", "");
  await expect(composer.locator('[data-source="prompt"]')).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await card.getByRole("button").first().click();
  await expect(outer).not.toHaveAttribute("inert", "");
  await guest.locator("#drill").click();
  await expect(composer.locator('[data-source="prompt"]')).toContainText(
    "CZ:ns",
  );
  await expect(composer.locator('[data-source="prompt"]')).toContainText(
    "2026",
  );
  expect(sends).toEqual([]);
  await guest.getByRole("link", { name: "Decision source" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(externalUrl);
  await expect(dialog.locator("strong")).toHaveText("?language=cs&year=2026");
  expect(popups).toEqual([]);
  const popupReady = page.waitForEvent("popup");
  await dialog.getByRole("button").last().click();
  const popup = await popupReady;
  await expect(popup).toHaveURL(externalUrl);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  expect(reads).toBe(1);
  expect(sends).toEqual([]);
  await popup.close();
  await page.setViewportSize({ width: 640, height: 900 });
  await guest.getByRole("button", { name: "Open decision" }).click();
  await expect(page).toHaveURL(
    new URL(DOCKED_CHAT_LEGAL_ROUTES.decision.path, page.url()).href,
  );
});
