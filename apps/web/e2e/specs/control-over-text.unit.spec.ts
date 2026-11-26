import { expect, test } from "@playwright/test";

import { findControlsOverText } from "../helpers/control-over-text";

test.use({ storageState: { cookies: [], origins: [] } });

const STYLE = `
  <style>
    body { margin: 0; font: 14px/20px sans-serif; }
    .box { width: 300px; border: 1px solid #d4d4d8; }
    .send { width: 28px; height: 28px; }
  </style>
`;

const DRAFT =
  "Please draft the reply to opposing counsel about the disclosure schedule, the deadline the court set and the exhibits still missing from the bundle.";

test("flags a send button positioned over an editor's text", async ({
  page,
}) => {
  await page.setContent(
    `${STYLE}<div class="box" style="position: relative">
      <div contenteditable="true">${DRAFT}</div>
      <button class="send" aria-label="Send" style="position: absolute; inset-inline-end: 4px; top: 0">↑</button>
    </div>`,
  );

  expect(await findControlsOverText(page)).toEqual([
    'button "Send" covers text in div',
  ]);
});

test("flags a control over the visible part of a textarea", async ({
  page,
}) => {
  await page.setContent(
    `${STYLE}<div class="box" style="position: relative">
      <textarea style="width: 100%; height: 80px; box-sizing: border-box">${DRAFT}</textarea>
      <button class="send" aria-label="Send" style="position: absolute; right: 4px; top: 4px">↑</button>
    </div>`,
  );

  expect(await findControlsOverText(page)).toHaveLength(1);
});

test("accepts controls in a row below the text, and beside one line", async ({
  page,
}) => {
  await page.setContent(
    `${STYLE}<div class="box">
      <div contenteditable="true">${DRAFT}</div>
      <div style="display: flex; justify-content: space-between">
        <button class="send" aria-label="Attach">+</button>
        <button class="send" aria-label="Send">↑</button>
      </div>
    </div>
    <div class="box" style="display: grid; grid-template-columns: auto 1fr auto; align-items: center">
      <button class="send" aria-label="Attach">+</button>
      <div contenteditable="true">One line</div>
      <button class="send" aria-label="Send">↑</button>
    </div>`,
  );

  expect(await findControlsOverText(page)).toEqual([]);
});

test("skips a control under a transparent ancestor", async ({ page }) => {
  // The button's own opacity is 1; only its wrapper is transparent, so
  // nothing is painted over the text.
  await page.setContent(
    `${STYLE}<div class="box" style="position: relative">
      <div contenteditable="true">${DRAFT}</div>
      <div style="opacity: 0">
        <button class="send" aria-label="Send" style="position: absolute; right: 4px; top: 0">↑</button>
      </div>
    </div>`,
  );

  expect(await findControlsOverText(page)).toEqual([]);
});

test("skips a control its clipping ancestor hides entirely", async ({
  page,
}) => {
  // The button's own box sits over the text, but a zero-height clipping
  // wrapper shows none of it; the textbox itself is not clipped.
  await page.setContent(
    `${STYLE}<div class="box" style="position: relative">
      <div contenteditable="true">${DRAFT}</div>
      <div style="position: absolute; right: 4px; top: 0; width: 28px; height: 0; overflow: hidden">
        <button class="send" aria-label="Send">↑</button>
      </div>
    </div>`,
  );

  expect(await findControlsOverText(page)).toEqual([]);
});

test("reads only the text a scroll region lets show", async ({ page }) => {
  // The text runs on under the control row, but the region clips it there:
  // what is painted never meets the buttons.
  await page.setContent(
    `${STYLE}<div class="box" style="position: relative">
      <div style="height: 60px; overflow: hidden">
        <div contenteditable="true">${DRAFT} ${DRAFT} ${DRAFT}</div>
      </div>
      <div style="display: flex; justify-content: flex-end">
        <button class="send" aria-label="Send">↑</button>
      </div>
    </div>`,
  );

  expect(await findControlsOverText(page)).toEqual([]);
});
