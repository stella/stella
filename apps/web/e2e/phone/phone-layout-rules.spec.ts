import { expect, test } from "@playwright/test";

import { findPhoneLayoutProblems } from "../helpers/phone-layout";

test.use({ storageState: { cookies: [], origins: [] } });

for (const { distance, crowded } of [
  { distance: 23, crowded: true },
  { distance: 24, crowded: false },
  { distance: 25, crowded: false },
]) {
  test(`undersized targets with centres ${distance}px apart respect circle spacing`, async ({
    page,
  }) => {
    // safe-html: static test controls with a numeric fixture offset.
    await page.setContent(`
      <style>
        button { position: absolute; top: 50px; width: 10px; height: 10px; padding: 0; border: 0; }
        #first { left: 50px; }
        #second { left: ${50 + distance}px; }
      </style>
      <button id="first" aria-label="First"></button>
      <button id="second" aria-label="Second"></button>
    `);
    const problems = await findPhoneLayoutProblems(page);
    expect(problems.some((problem) => problem === "small touch targets:")).toBe(
      crowded,
    );
    expect(problems).toHaveLength(crowded ? 3 : 0);
  });
}

for (const pseudo of ["before", "after"]) {
  for (const pointerEvents of ["auto", "none"]) {
    test(`${pseudo} enlarges a touch target only with pointer events ${pointerEvents}`, async ({
      page,
    }) => {
      // safe-html: static controls with enumerated CSS fixture values.
      await page.setContent(`
        <style>
          button { position: absolute; top: 50px; width: 10px; height: 10px; padding: 0; border: 0; }
          button::${pseudo} { content: ""; position: absolute; width: 30px; height: 30px; inset: -10px; pointer-events: ${pointerEvents}; }
          #first { left: 50px; }
          #second { left: 70px; }
        </style>
        <button id="first" aria-label="First"></button>
        <button id="second" aria-label="Second"></button>
      `);
      expect(await findPhoneLayoutProblems(page)).toHaveLength(
        pointerEvents === "auto" ? 0 : 3,
      );
    });
  }
}

for (const axis of ["x", "y"]) {
  for (const offset of [-40, -10, 80, 110]) {
    test(`non-scrollable ${axis} clipping detects a control at ${offset}px`, async ({
      page,
    }) => {
      // safe-html: static controls with enumerated geometry fixture values.
      await page.setContent(`
        <style>
          #box { position: absolute; left: 50px; top: 50px; width: 100px; height: 100px; overflow: hidden; }
          button { position: absolute; left: ${axis === "x" ? offset : 20}px; top: ${axis === "y" ? offset : 20}px; width: 30px; height: 30px; }
        </style>
        <div id="box"><button aria-label="Clipped"></button></div>
      `);
      expect(await findPhoneLayoutProblems(page)).toEqual([
        "cut-off controls:",
        `  button "Clipped" is cut off at the ${axis === "x" ? "side" : "top or bottom"} of div`,
      ]);
    });
  }
}

for (const hidden of [
  "hidden",
  'aria-hidden="true"',
  "inert",
  'style="visibility:hidden"',
]) {
  test(`explicit hidden region ${hidden} excludes clipped controls`, async ({
    page,
  }) => {
    // safe-html: static controls with enumerated hiding fixture attributes.
    await page.setContent(`
      <style>
        #box { position: absolute; left: 50px; top: 50px; width: 100px; height: 100px; overflow: hidden; }
        button { position: absolute; left: 110px; top: 110px; width: 30px; height: 30px; }
      </style>
      <div id="box" ${hidden}><button aria-label="Hidden"></button></div>
    `);
    expect(await findPhoneLayoutProblems(page)).toEqual([]);
  });
}

for (const { axis, direction, reachableOffset, unreachableOffset } of [
  { axis: "x", direction: "ltr", reachableOffset: 220, unreachableOffset: -40 },
  {
    axis: "x",
    direction: "rtl",
    reachableOffset: -140,
    unreachableOffset: 110,
  },
  { axis: "y", direction: "ltr", reachableOffset: 220, unreachableOffset: -40 },
]) {
  for (const placement of ["reachable", "unreachable"]) {
    for (const scrolled of [false, true]) {
      test(`${direction} ${axis} scroll range keeps ${placement} control ${scrolled ? "after scrolling" : "at origin"}`, async ({
        page,
      }) => {
        const offset =
          placement === "reachable" ? reachableOffset : unreachableOffset;
        // safe-html: static controls with enumerated geometry fixture values.
        await page.setContent(`
          <style>
            #box { position: absolute; left: 50px; top: 50px; width: 100px; height: 100px; overflow: auto; direction: ${direction}; }
            #extent { position: absolute; left: ${direction === "rtl" ? -200 : 0}px; top: 0; width: ${axis === "x" ? 300 : 1}px; height: ${axis === "y" ? 300 : 1}px; }
            button { position: absolute; left: ${axis === "x" ? offset : 20}px; top: ${axis === "y" ? offset : 20}px; width: 30px; height: 30px; }
          </style>
          <div id="box"><div id="extent"></div><button aria-label="Target"></button></div>
        `);
        const metrics = await page.locator("#box").evaluate(
          (box, fixture) => {
            if (fixture.scrolled) {
              box.scrollLeft = fixture.direction === "rtl" ? -200 : 200;
              box.scrollTop = 200;
            }
            return {
              x: box.scrollWidth - box.clientWidth,
              y: box.scrollHeight - box.clientHeight,
              left: box.scrollLeft,
              top: box.scrollTop,
            };
          },
          { axis, direction, scrolled },
        );
        expect(axis === "x" ? metrics.x : metrics.y).toBeGreaterThan(0);
        expect(axis === "x" ? metrics.left !== 0 : metrics.top !== 0).toBe(
          scrolled,
        );
        const problems = await findPhoneLayoutProblems(page);
        expect(problems).toEqual(
          placement === "reachable"
            ? []
            : [
                "cut-off controls:",
                `  button "Target" is cut off at the ${axis === "x" ? "side" : "top or bottom"} of div`,
              ],
        );
      });
    }
  }
}

for (const { tag, field } of [
  { tag: "input", field: '<input id="field" aria-label="Field">' },
  {
    tag: "select",
    field:
      '<select id="field" aria-label="Field"><option>Value</option></select>',
  },
  {
    tag: "textarea",
    field: '<textarea id="field" aria-label="Field"></textarea>',
  },
]) {
  for (const { proxy, markup, visible } of [
    { proxy: "none", markup: "", visible: false },
    {
      proxy: "label",
      markup: '<label for="field">Choose value</label>',
      visible: true,
    },
    {
      proxy: "overlap",
      markup: '<span id="proxy">Choose value</span>',
      visible: true,
    },
    {
      proxy: "hidden-label",
      markup: '<label for="field" style="opacity:0">Choose value</label>',
      visible: false,
    },
    {
      proxy: "hidden-overlap",
      markup: '<span id="proxy" style="opacity:0">Choose value</span>',
      visible: false,
    },
    {
      proxy: "unrelated-label",
      markup: '<label for="other">Choose value</label>',
      visible: false,
    },
    {
      proxy: "empty-overlap",
      markup: '<span id="proxy" style="background:transparent"></span>',
      visible: false,
    },
    {
      proxy: "decorative-overlap",
      markup:
        '<span id="proxy" aria-hidden="true" style="pointer-events:none">Choose value</span>',
      visible: true,
    },
  ]) {
    test(`transparent ${tag} requires a visible proxy: ${proxy}`, async ({
      page,
    }) => {
      // safe-html: static native field and enumerated proxy fixture markup.
      await page.setContent(`
        <style>
          #field, #proxy { position: absolute; left: 50px; top: 50px; width: 100px; height: 40px; }
          #field { opacity: 0; z-index: 1; }
          #proxy { background: gray; }
          label { position: absolute; left: 50px; top: 120px; }
        </style>
        ${field}
        ${markup}
      `);
      expect(await findPhoneLayoutProblems(page)).toEqual(
        visible
          ? []
          : [
              "hover-only controls:",
              `  ${tag} "Field" is invisible until hovered`,
            ],
      );
    });
  }
}

for (const visibility of ["visible", "hidden"]) {
  test(`a control with visibility ${visibility} is checked for hover-only availability`, async ({
    page,
  }) => {
    // safe-html: static control with enumerated visibility fixture value.
    await page.setContent(`
      <style>
        button { position: absolute; left: 50px; top: 50px; width: 40px; height: 40px; visibility: ${visibility}; }
        button:hover { visibility: visible; }
      </style>
      <button aria-label="Action"></button>
    `);
    expect(await findPhoneLayoutProblems(page)).toEqual(
      visibility === "visible"
        ? []
        : [
            "hover-only controls:",
            '  button "Action" is invisible until hovered',
          ],
    );
  });
}

for (const root of ["html", "body"]) {
  for (const overflow of ["auto", "hidden", "clip"]) {
    test(`${root} overflow-y ${overflow} determines whether a below-screen control can be reached`, async ({
      page,
    }) => {
      // safe-html: static control with enumerated root overflow fixture values.
      await page.setContent(`
        <style>
          html, body { margin: 0; height: 100%; }
          ${root} { overflow-y: ${overflow}; }
          button { position: absolute; left: 50px; top: 120vh; width: 40px; height: 40px; }
        </style>
        <button aria-label="Below screen"></button>
      `);
      expect(await findPhoneLayoutProblems(page)).toEqual(
        overflow === "auto"
          ? []
          : [
              "cut-off controls:",
              '  button "Below screen" sits past the top or bottom of a non-scrollable page',
            ],
      );
    });
  }
}
