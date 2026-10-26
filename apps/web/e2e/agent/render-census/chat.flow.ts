import { expect } from "@playwright/test";
import { EventType } from "@tanstack/ai";
import { panic } from "better-result";
import * as v from "valibot";

import { STREAM_CHUNK_COMMIT_BUDGET } from "../../../src/features/chat/stream-chunk-commit-budget";
import { apiDelete, apiGet } from "../../helpers/api";
import type { DriveScriptContext } from "../drive-context";
import { legalClause } from "./legal-fixtures";

const textDelta = v.object({
  type: v.literal(EventType.TEXT_MESSAGE_CONTENT),
  delta: v.string(),
});

const runChatCensus = async ({ page, measureAction }: DriveScriptContext) => {
  const availability = v.parse(
    v.object({ mockAnswers: v.boolean() }),
    await apiGet(page.request, "/organization-settings/ai-availability"),
  );
  if (!availability.mockAnswers) {
    panic("Chat render census requires the mock model; no message was sent");
  }
  let threadPath: string | undefined;
  try {
    await page.goto("/chat", { waitUntil: "domcontentloaded" });
    const composer = page.getByRole("textbox", {
      name: /type your question/iu,
    });
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.pressSequentially(
      "Posuďte návaznost předávacího protokolu na odpovědnost za vady při převzetí areálu.",
    );
    await measureAction("chat: send first message", async () => {
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await expect(
        page
          .getByRole("log")
          .getByRole("button", { name: "Retry", exact: true }),
      ).toHaveCount(1, { timeout: 60_000 });
    });
    threadPath = new URL(page.url()).pathname;
    // Compare one existing exchange with ten; setup turns use the same UI and mock.
    for (let exchanges = 1; exchanges <= 10; exchanges++) {
      const input = page.locator('[role="textbox"][contenteditable="true"]');
      if (exchanges === 1 || exchanges === 10) {
        await input.pressSequentially(
          `Vysvětlete rizika ujednání „${legalClause(exchanges).heading}“. ${STREAM_CHUNK_COMMIT_BUDGET.text.mockAiMarker}`,
        );
        await measureAction(
          `chat ${String(exchanges)} exchanges: whole text stream`,
          async () => {
            const responsePromise = page.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === "/v1/chat",
            );
            await page
              .getByRole("button", { name: "Send message", exact: true })
              .click();
            const response = await responsePromise;
            if (!response.ok()) {
              panic(`Mock stream failed: ${String(response.status())}`);
            }
            const stream = await response.text();
            let textDeltas = 0;
            for (const line of stream.split(/\r?\n/u)) {
              if (
                !line.startsWith("data:") ||
                line.slice(5).trim() === "[DONE]"
              ) {
                continue;
              }
              const event: unknown = JSON.parse(line.slice(5));
              if (v.safeParse(textDelta, event).success) {
                textDeltas++;
              }
            }
            if (textDeltas === 0) {
              panic("Mock text stream delivered no text deltas");
            }
            await expect(
              page.getByRole("button", { name: "Stop", exact: true }),
            ).toHaveCount(0, { timeout: 60_000 });
            await expect(
              page
                .getByRole("log")
                .getByRole("button", { name: "Retry", exact: true }),
            ).toHaveCount(exchanges + 1);
            return { textDeltas };
          },
        );
        continue;
      }
      await input.pressSequentially(
        `Zhodnoťte, které podklady doloží splnění této povinnosti: ${legalClause(exchanges).paragraph}`,
      );
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await expect(
        page
          .getByRole("log")
          .getByRole("button", { name: "Retry", exact: true }),
      ).toHaveCount(exchanges + 1, { timeout: 60_000 });
    }
  } finally {
    if (threadPath !== undefined && /^\/chat\/[0-9a-f-]+$/u.test(threadPath)) {
      await page.goto("/workspaces", { waitUntil: "domcontentloaded" });
      await apiDelete(
        page.request,
        `/chat/threads/${threadPath.split("/").at(-1)}`,
      );
    }
  }
};

export default runChatCensus;
