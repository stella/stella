import * as v from "valibot";

import {
  GENERATED_VISUAL_MIME_TYPE,
  GENERATED_VISUAL_URI_PREFIX,
  generatedVisualPageSchema,
  generatedVisualPartSchema,
} from "@stll/api-contract/generated-visual";
import { VISUAL_PREVIEW_TOOL_NAME } from "@stll/api-contract/visual-preview";

import messages from "../../src/i18n/langs/en.json" with { type: "json" };
import { installDockedChatHistory } from "../helpers/docked-chat-fixtures";
import { dockedChatMessagePage } from "../helpers/docked-chat-history";
import {
  DOCKED_CHAT_LEGAL_ROUTES,
  installDockedLegalFixtures,
} from "../helpers/docked-chat-legal-fixtures";
import { expect, test } from "../helpers/test";

// Trace snapshots run script inside every frame, and Chromium counts that
// as a user gesture in the frame. This spec checks which actions need a
// gesture, so it runs without tracing.
test.use({ trace: "off" });

const threadId = "019a0000-0000-7000-8000-000000000001";
const fileId = "019a0000-0000-7000-8000-000000000003";
const externalUrl = "https://example.test/decision?language=cs&year=2026";
const title = "Court timeline";
const visual = v.parse(generatedVisualPageSchema, {
  title,
  html: `<section class="stella-card"><p id="note">Decisions by court</p><div id="space" style="height:480px"></div><button id="drill">Court year</button><button id="internal">Open decision</button><a href="${externalUrl}">Decision source</a></section><script>const bucket=stella.data.courtYear.buckets[0];document.querySelector('#drill').addEventListener('click',()=>stella.drill({court:bucket.court,year:bucket.year}));document.querySelector('#internal').addEventListener('click',()=>stella.openDecision('decision'));document.querySelector('#note').addEventListener('click',()=>setTimeout(()=>{stella.drill({court:bucket.court,year:bucket.year});document.querySelector('#space').style.height='800px';document.body.dataset.laterDrill='sent';},1500),{once:true});stella.drill({court:bucket.court,year:bucket.year});stella.openDecision('decision');document.querySelector('a').click();document.body.dataset.initialActions='sent';stella.ready();</script>`,
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

test("generated view is live inline, reloads, and acts only on user gestures", async ({
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
  // Live from the start: no activation step, nothing inert.
  await expect(outer).not.toHaveAttribute("inert");
  const card = outer.locator("xpath=ancestor::section[1]");
  await expect(card.getByRole("button")).toHaveCount(0);
  await expect(card.locator("header")).toContainText(title);
  const composer = page.locator('[role="textbox"][contenteditable="true"]');
  const prompts = composer.locator('[data-source="prompt"]');
  // Initial sizing confirms the view is ready before direct interaction.
  await expect
    .poll(async () =>
      outer.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeGreaterThan(480);
  await expect(prompts).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/chat/${threadId}$`, "u"));
  expect(popups).toEqual([]);
  const guest = page
    .frameLocator(`iframe[title="${title}"]`)
    .frameLocator("iframe");
  await expect
    .poll(
      async () =>
        outer.evaluate((element) => {
          const section = element.closest("section");
          const message = element.closest("[data-chat-message-id]");
          if (section === null || message === null) {
            return false;
          }
          return (
            Math.abs(
              section.getBoundingClientRect().width -
                message.getBoundingClientRect().width,
            ) <= 1
          );
        }),
      { message: "generated view fills the chat content column" },
    )
    .toBe(true);
  // Text in the view can be selected without activating anything.
  await guest.locator("#note").click({ clickCount: 3 });
  expect(
    await guest
      .locator("body")
      .evaluate(() => window.getSelection()?.toString().trim()),
  ).toBe("Decisions by court");
  // A gesture backs one action only while it is recent: script that acts
  // on a timer more than a second after the selection reaches nothing. The
  // view resizes right after that action, and the view's messages arrive in
  // order, so the new height shows the action would have arrived by now.
  await expect(guest.locator("body")).toHaveAttribute(
    "data-later-drill",
    "sent",
  );
  await expect
    .poll(async () =>
      outer.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeGreaterThan(800);
  await expect(prompts).toHaveCount(0);
  // A real click inside the view acts at once.
  await guest.locator("#drill").click();
  await expect(prompts).toHaveCount(1);
  await expect(prompts).toContainText("CZ:ns");
  await expect(prompts).toContainText("2026");
  expect(sends).toEqual([]);
  await guest.getByRole("link", { name: "Decision source" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(externalUrl);
  await expect(dialog.locator("strong")).toHaveText("?language=cs&year=2026");
  expect(popups).toEqual([]);
  const popupReady = page.waitForEvent("popup");
  await dialog
    .getByRole("button", { name: messages.inspector.external.openLink })
    .click();
  const popup = await popupReady;
  await expect(popup).toHaveURL(externalUrl);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  expect(reads).toBe(1);
  expect(sends).toEqual([]);
  await popup.close();
  // The frame keeps its document and its URL until something reloads it. A
  // reloaded shell starts a new handshake under a new URL and renders again.
  // Assigning the same URL only navigates to its fragment, so the shell is
  // reloaded by loading another document first and then the same URL again.
  const initialSrc = await outer.getAttribute("src");
  await outer.evaluate(async (element) => {
    if (!(element instanceof HTMLIFrameElement)) {
      return;
    }
    const shellUrl = element.src;
    const blankLoaded = new Promise((resolve) => {
      element.addEventListener("load", resolve, { once: true });
    });
    element.setAttribute("src", "about:blank");
    await blankLoaded;
    element.setAttribute("src", shellUrl);
  });
  await expect(outer).not.toHaveAttribute("src", initialSrc ?? "");
  await expect(guest.locator("body")).toHaveAttribute(
    "data-initial-actions",
    "sent",
  );
  expect(reads).toBe(1);
  await page.setViewportSize({ width: 640, height: 900 });
  await guest.getByRole("button", { name: "Open decision" }).click();
  await expect(page).toHaveURL(
    new URL(DOCKED_CHAT_LEGAL_ROUTES.decision.path, page.url()).href,
  );
});
