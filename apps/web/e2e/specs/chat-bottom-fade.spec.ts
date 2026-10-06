import { expect, test } from "../helpers/test";

const LONG_REVIEW_REQUEST = Array.from(
  { length: 24 },
  (_, index) =>
    `Review provision ${String(index + 1)} of the agreement for its statutory grounds, the interests it protects, and the consequences of invalidity.`,
).join("\n\n");

test("transcript fade appears only while content remains below the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto("/chat", { waitUntil: "commit" });
  const composer = page.locator('[role="textbox"][contenteditable="true"]');
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill(LONG_REVIEW_REQUEST);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/u, { timeout: 30_000 });
  const transcript = page.getByRole("log");
  await expect(transcript.getByRole("button", { name: "Retry" })).toBeVisible({
    timeout: 30_000,
  });
  const viewport = transcript.locator('[data-slot="scroll-area-viewport"]');
  const fade = page.locator("[data-chat-bottom-fade]");
  expect(
    await viewport.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    ),
  ).toBeGreaterThan(200);
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(fade).toBeHidden();
  expect(
    await viewport.evaluate((element) => getComputedStyle(element).maskImage),
  ).toBe("none");

  await viewport.hover();
  await page.mouse.wheel(0, -300);
  await expect(fade).toBeVisible();
  const clearance = await viewport.evaluate((element) => {
    const content = element.firstElementChild;
    const fadeElement = document.querySelector("[data-chat-bottom-fade]");
    if (content === null || fadeElement === null) {
      throw new Error("Transcript clearance elements are missing");
    }
    return {
      padding: Number.parseFloat(getComputedStyle(content).paddingBottom),
      fade: fadeElement.getBoundingClientRect().height,
    };
  });
  expect(clearance.padding).toBeGreaterThanOrEqual(clearance.fade);
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(fade).toBeHidden();

  await composer.fill("Stream slowly please");
  await page.getByRole("button", { name: "Send message" }).click();
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await expect(fade).toBeHidden();
  await expect(stop).toBeHidden({ timeout: 30_000 });
  await expect(fade).toBeHidden();
});
