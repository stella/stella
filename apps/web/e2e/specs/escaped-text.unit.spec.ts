import { expect, test } from "@playwright/test";

import { findEscapedText } from "../helpers/escaped-text";

test.use({ storageState: { cookies: [], origins: [] } });

const LONG = "Podať námietky v podateľni ÚVO a doručiť rovnopis kontrolovanému";

const STYLE = `
  <style>
    body { margin: 0; font: 14px sans-serif; }
    .card {
      display: flex; flex-direction: column; align-items: flex-start;
      width: 300px; border: 1px solid #d4d4d8;
    }
  </style>
`;

// A 300px card the reader sees as one box, laid out as the matter overview's
// stat cards are: a flex column that does not stretch its children. Each
// card's own style is inline, so one card's clip cannot hide another's leak.
const card = (text: string, cardStyle = "", labelStyle = "") =>
  `<div class="card" style="${cardStyle}"><span style="${labelStyle}">${text}</span></div>`;

test("flags a nowrap line that runs past a card that does not stretch it", async ({
  page,
}) => {
  await page.setContent(STYLE + card(LONG, "", "white-space: nowrap"));

  expect(await findEscapedText(page)).toEqual([
    `"${LONG.slice(0, 40)}…" escapes div.card`,
  ]);
});

test("flags an unbroken word wider than its card", async ({ page }) => {
  await page.setContent(STYLE + card("x".repeat(80)));

  expect(await findEscapedText(page)).toHaveLength(1);
});

test("accepts text the card wraps or an element cuts off", async ({ page }) => {
  await page.setContent(`
    ${STYLE}
    ${card(LONG)}
    ${card(
      LONG,
      "",
      "display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap",
    )}
    ${card(LONG, "overflow: hidden", "white-space: nowrap")}
  `);

  expect(await findEscapedText(page)).toEqual([]);
});

test("checks only inside the scope it is given", async ({ page }) => {
  await page.setContent(`
    ${STYLE}
    <section id="clean">${card("Short")}</section>
    ${card(LONG, "", "white-space: nowrap")}
  `);

  expect(await findEscapedText(page.locator("#clean"))).toEqual([]);
  expect(await findEscapedText(page)).toHaveLength(1);
});

test("leaves a host's own box to the host", async ({ page }) => {
  // The scope sits in a short filled host it overflows: the host's box is
  // not the scope's to keep.
  await page.setContent(`
    ${STYLE}
    <div style="height: 20px; background: #f4f4f5">
      <section id="tall" style="height: 200px">
        <p style="margin: 120px 0 0">Below the host</p>
      </section>
    </div>
  `);

  expect(await findEscapedText(page.locator("#tall"))).toEqual([]);
  expect(await findEscapedText(page)).toHaveLength(1);
});
