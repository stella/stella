/**
 * An answer reads as prose: headings stay close to the body, list items keep
 * one rhythm at every depth, and the question it answers is a bubble at the
 * end of the column rather than a full-width band.
 *
 * The bench at `/dev?visual=chat-answer-typography` renders a finished turn
 * through the real transcript, with a title, section headings and a bullet
 * list whose first item holds a nested list.
 */

import {
  expect,
  expectGeometry,
  stableBoundingBox,
  test,
} from "../helpers/stable-geometry";

// Subpixel layout can split a measured gap by a fraction of a pixel.
const EPSILON_PX = 1;

test("an answer keeps headings near the body and one rhythm between list items", async ({
  page,
}) => {
  await page.goto("/dev?visual=chat-answer-typography", {
    waitUntil: "domcontentloaded",
  });
  const answer = page.locator(".is-assistant").first();
  const title = answer.locator("h1").first();
  await expect(title).toBeVisible();

  const fontSize = async (selector: string) =>
    await answer
      .locator(selector)
      .first()
      .evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      );
  const body = await fontSize("p");
  // A model's page title reads as a section heading, not as a page.
  expect(await fontSize("h1")).toBe(await fontSize("h2"));
  expect(await fontSize("h2")).toBeLessThanOrEqual(body * 1.25);

  // The first bullet holds a nested list; the gap after that nested list is
  // the same as the gap between two plain bullets. Measured between the text
  // of the items, not their boxes: the uneven gap lived in an item's padding
  // and its nested list's margin, both inside the item's own box.
  const list = answer.locator("ul:has(li ul)").first();
  await expect(list.locator(":scope > li")).toHaveCount(3);
  await stableBoundingBox(page, list);
  const gaps = await list.evaluate((element) => {
    const textExtent = (item: Element) => {
      const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
      let top = Number.POSITIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) {
          continue;
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          top = Math.min(top, rect.top);
          bottom = Math.max(bottom, rect.bottom);
        }
      }
      return { top, bottom };
    };
    const between = (items: Element[]) => {
      const extents = items.map(textExtent);
      return extents
        .slice(1)
        .map((extent, index) => extent.top - (extents[index]?.bottom ?? 0));
    };
    return {
      topLevel: between([...element.querySelectorAll(":scope > li")]),
      nested: between([...element.querySelectorAll(":scope > li > ul > li")]),
    };
  });
  const [afterNested, betweenPlain] = gaps.topLevel;
  const [betweenNested] = gaps.nested;
  if (
    afterNested === undefined ||
    betweenPlain === undefined ||
    betweenNested === undefined
  ) {
    throw new Error(
      "The fixture's list must hold three items and a nested pair",
    );
  }
  expectGeometry(afterNested, betweenPlain, EPSILON_PX);
  expectGeometry(betweenNested, betweenPlain, EPSILON_PX);
});

test("the question is a bubble that hugs its text at the end of the column", async ({
  page,
}) => {
  await page.goto("/dev?visual=chat-answer-typography", {
    waitUntil: "domcontentloaded",
  });
  const message = page.locator(".is-user").first();
  const bubble = message.locator(":scope > *").first();
  await expect(bubble).toBeVisible();
  const messageBox = await stableBoundingBox(page, message);
  const bubbleBox = await stableBoundingBox(page, bubble);
  expect(bubbleBox.width).toBeLessThan(messageBox.width);
  const rtl = await message.evaluate(
    (element) => getComputedStyle(element).direction === "rtl",
  );
  // The bubble sits at the column's end edge: right in LTR, left in RTL.
  if (rtl) {
    expectGeometry(bubbleBox.x, messageBox.x, EPSILON_PX);
  } else {
    expectGeometry(
      bubbleBox.x + bubbleBox.width,
      messageBox.x + messageBox.width,
      EPSILON_PX,
    );
  }
});
