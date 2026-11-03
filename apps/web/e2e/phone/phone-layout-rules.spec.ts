import { expect, test } from "@playwright/test";

import {
  findPhoneLayoutProblems,
  setPhoneContent,
} from "../helpers/phone-layout";

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
    await setPhoneContent(
      page,
      `
      <style>
        button { position: absolute; top: 50px; width: 10px; height: 10px; padding: 0; border: 0; }
        #first { left: 50px; }
        #second { left: ${50 + distance}px; }
      </style>
      <button id="first" aria-label="First"></button>
      <button id="second" aria-label="Second"></button>
    `,
    );
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
      await setPhoneContent(
        page,
        `
        <style>
          button { position: absolute; top: 50px; width: 10px; height: 10px; padding: 0; border: 0; }
          button::${pseudo} { content: ""; position: absolute; width: 30px; height: 30px; inset: -10px; pointer-events: ${pointerEvents}; }
          #first { left: 50px; }
          #second { left: 70px; }
        </style>
        <button id="first" aria-label="First"></button>
        <button id="second" aria-label="Second"></button>
      `,
      );
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
      await setPhoneContent(
        page,
        `
        <style>
          #box { position: absolute; left: 50px; top: 50px; width: 100px; height: 100px; overflow: hidden; }
          button { position: absolute; left: ${axis === "x" ? offset : 20}px; top: ${axis === "y" ? offset : 20}px; width: 30px; height: 30px; }
        </style>
        <div id="box"><button aria-label="Clipped"></button></div>
      `,
      );
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
    await setPhoneContent(
      page,
      `
      <style>
        #box { position: absolute; left: 50px; top: 50px; width: 100px; height: 100px; overflow: hidden; }
        button { position: absolute; left: 110px; top: 110px; width: 30px; height: 30px; }
      </style>
      <div id="box" ${hidden}><button aria-label="Hidden"></button></div>
    `,
    );
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
        await setPhoneContent(
          page,
          `
          <style>
            #box { position: absolute; left: 50px; top: 50px; width: 100px; height: 100px; overflow: auto; direction: ${direction}; }
            #extent { position: absolute; left: ${direction === "rtl" ? -200 : 0}px; top: 0; width: ${axis === "x" ? 300 : 1}px; height: ${axis === "y" ? 300 : 1}px; }
            button { position: absolute; left: ${axis === "x" ? offset : 20}px; top: ${axis === "y" ? offset : 20}px; width: 30px; height: 30px; }
          </style>
          <div id="box"><div id="extent"></div><button aria-label="Target"></button></div>
        `,
        );
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
      await setPhoneContent(
        page,
        `
        <style>
          #field, #proxy { position: absolute; left: 50px; top: 50px; width: 100px; height: 40px; }
          #field { opacity: 0; z-index: 1; }
          #proxy { background: gray; }
          label { position: absolute; left: 50px; top: 120px; }
        </style>
        ${field}
        ${markup}
      `,
      );
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
    await setPhoneContent(
      page,
      `
      <style>
        button { position: absolute; left: 50px; top: 50px; width: 40px; height: 40px; visibility: ${visibility}; }
        button:hover { visibility: visible; }
      </style>
      <button aria-label="Action"></button>
    `,
    );
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
      await setPhoneContent(
        page,
        `
        <style>
          html, body { margin: 0; height: 100%; }
          ${root} { overflow-y: ${overflow}; }
          button { position: absolute; left: 50px; top: 120vh; width: 40px; height: 40px; }
        </style>
        <button aria-label="Below screen"></button>
      `,
      );
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

// The root element's overflow decides the viewport unless it is visible; only
// then does the body's propagate. Otherwise the body clips as its own box.
for (const { html, body, cutOffBy } of [
  { html: "visible", body: "auto", cutOffBy: null },
  { html: "visible", body: "hidden", cutOffBy: "page" },
  { html: "hidden", body: "auto", cutOffBy: null },
  { html: "hidden", body: "hidden", cutOffBy: "body" },
  { html: "auto", body: "hidden", cutOffBy: "body" },
] as const) {
  test(`html overflow ${html} with body overflow ${body} decides who scrolls a below-screen control`, async ({
    page,
  }) => {
    // safe-html: static in-flow control with enumerated root overflow fixture values.
    await setPhoneContent(
      page,
      `
      <style>
        html, body { margin: 0; height: 100%; }
        html { overflow: ${html}; }
        body { overflow: ${body}; }
        #spacer { height: 120vh; }
        button { display: block; width: 40px; height: 40px; }
      </style>
      <div id="spacer"></div>
      <button aria-label="Below screen"></button>
    `,
    );
    expect(
      await page
        .getByRole("button", { name: "Below screen" })
        .evaluate(
          (button) => button.getBoundingClientRect().top > window.innerHeight,
        ),
    ).toBe(true);
    const problems = await findPhoneLayoutProblems(page);
    switch (cutOffBy) {
      case null:
        expect(problems).toEqual([]);
        break;
      case "page":
        expect(problems).toEqual([
          "cut-off controls:",
          '  button "Below screen" sits past the top or bottom of a non-scrollable page',
        ]);
        break;
      case "body":
        expect(problems).toEqual([
          "cut-off controls:",
          expect.stringMatching(
            /^ {2}button "Below screen" is cut off at the top or bottom of body\b/u,
          ),
        ]);
        break;
      default:
        cutOffBy satisfies never;
    }
  });
}

test("a page without a device-width viewport is reported as zoomed out", async ({
  page,
}) => {
  // safe-html: static control in a document without a viewport declaration.
  await page.setContent(`<!doctype html><button>Action</button>`);
  expect(await findPhoneLayoutProblems(page)).toEqual([
    "zoomed-out layout:",
    expect.stringMatching(
      /^ {2}page is laid out \d+px wide and shown at \d+% to fit the screen; declare a width=device-width viewport$/u,
    ),
  ]);
});

const nestedScrollAxes = [
  { axis: "x", direction: "ltr", targetOffset: 200 },
  { axis: "x", direction: "rtl", targetOffset: -140 },
  { axis: "y", direction: "ltr", targetOffset: 200 },
];

for (const { axis, direction, targetOffset } of nestedScrollAxes) {
  for (const { placement, offset, overlap, reachable } of [
    { placement: "inside", offset: 0, overlap: 100, reachable: true },
    { placement: "outside", offset: 120, overlap: 0, reachable: false },
    { placement: "wide overlap", offset: 60, overlap: 40, reachable: true },
    { placement: "narrow overlap", offset: 80, overlap: 20, reachable: false },
  ]) {
    for (const scrolled of [false, true]) {
      test(`nested ${direction} ${axis} scroller ${placement} a clipping ancestor ${scrolled ? "after scrolling" : "at origin"}`, async ({
        page,
      }) => {
        // safe-html: static nested controls with enumerated geometry fixture values.
        await setPhoneContent(
          page,
          `
          <style>
            #outer { position: absolute; left: 50px; top: 50px; width: 100px; height: 100px; overflow: hidden; }
            #inner { position: absolute; left: ${axis === "x" ? offset : 0}px; top: ${axis === "y" ? offset : 0}px; width: 100px; height: 100px; overflow: auto; direction: ${direction}; }
            #extent { position: absolute; left: ${direction === "rtl" ? -200 : 0}px; top: 0; width: ${axis === "x" ? 300 : 1}px; height: ${axis === "y" ? 300 : 1}px; }
            button { position: absolute; left: ${axis === "x" ? targetOffset : 20}px; top: ${axis === "y" ? targetOffset : 20}px; width: 30px; height: 30px; }
          </style>
          <div id="outer"><div id="inner"><div id="extent"></div><button aria-label="Nested"></button></div></div>
        `,
        );
        const inner = await page.locator("#inner").evaluate(
          (box, fixture) => {
            if (fixture.scrolled) {
              box.scrollLeft = fixture.direction === "rtl" ? -50 : 50;
              box.scrollTop = 50;
            }
            const rect = box.getBoundingClientRect();
            return {
              range:
                fixture.axis === "x"
                  ? box.scrollWidth - box.clientWidth
                  : box.scrollHeight - box.clientHeight,
              offset: fixture.axis === "x" ? box.scrollLeft : box.scrollTop,
              start: fixture.axis === "x" ? rect.left : rect.top,
              end: fixture.axis === "x" ? rect.right : rect.bottom,
            };
          },
          { axis, direction, scrolled },
        );
        const outer = await page
          .locator("#outer")
          .evaluate((box, fixtureAxis) => {
            const rect = box.getBoundingClientRect();
            return {
              start: fixtureAxis === "x" ? rect.left : rect.top,
              end: fixtureAxis === "x" ? rect.right : rect.bottom,
            };
          }, axis);
        expect(inner.range).toBe(200);
        expect(Math.abs(inner.offset)).toBe(scrolled ? 50 : 0);
        expect(
          Math.max(
            0,
            Math.min(inner.end, outer.end) - Math.max(inner.start, outer.start),
          ),
        ).toBe(overlap);
        await expect(
          page.getByRole("button", { name: "Nested" }),
        ).not.toBeInViewport();
        const problems = await findPhoneLayoutProblems(page);
        expect(problems.includes("cut-off controls:")).toBe(!reachable);
        expect(problems).toHaveLength(reachable ? 0 : 2);
        if (!reachable) {
          expect(problems.at(1)).toContain('button "Nested"');
        }
      });
    }
  }
}

for (const { axis, direction, targetOffset, root } of [
  { axis: "x", direction: "ltr", targetOffset: 200, root: "html" },
  { axis: "x", direction: "rtl", targetOffset: -140, root: "html" },
  { axis: "y", direction: "ltr", targetOffset: 200, root: "html" },
  { axis: "y", direction: "ltr", targetOffset: 200, root: "body" },
]) {
  for (const overlap of [0, 20, 40]) {
    for (const scrolled of [false, true]) {
      test(`nested ${direction} ${axis} scroller has ${overlap}px inside the ${root} viewport ${scrolled ? "after scrolling" : "at origin"}`, async ({
        page,
      }) => {
        // safe-html: static scroll control with enumerated root and geometry fixture values.
        await setPhoneContent(
          page,
          `
          <style>
            html, body { margin: 0; height: 100%; }
            ${root} { overflow: hidden; }
            #inner { position: ${axis === "x" ? "fixed" : "absolute"}; left: ${axis === "x" ? `calc(100vw - ${overlap}px)` : "50px"}; top: ${axis === "y" ? `calc(100vh - ${overlap}px)` : "50px"}; width: 100px; height: 100px; overflow: auto; direction: ${direction}; }
            #extent { position: absolute; left: ${direction === "rtl" ? -200 : 0}px; top: 0; width: ${axis === "x" ? 300 : 1}px; height: ${axis === "y" ? 300 : 1}px; }
            button { position: absolute; left: ${axis === "x" ? targetOffset : 20}px; top: ${axis === "y" ? targetOffset : 20}px; width: 30px; height: 30px; }
          </style>
          <div id="inner"><div id="extent"></div><button aria-label="Viewport nested"></button></div>
        `,
        );
        const metrics = await page.locator("#inner").evaluate(
          (box, fixture) => {
            if (fixture.scrolled) {
              box.scrollLeft = fixture.direction === "rtl" ? -50 : 50;
              box.scrollTop = 50;
            }
            const rect = box.getBoundingClientRect();
            return {
              range:
                fixture.axis === "x"
                  ? box.scrollWidth - box.clientWidth
                  : box.scrollHeight - box.clientHeight,
              offset: fixture.axis === "x" ? box.scrollLeft : box.scrollTop,
              overlap:
                fixture.axis === "x"
                  ? window.innerWidth - rect.left
                  : window.innerHeight - rect.top,
            };
          },
          { axis, direction, scrolled },
        );
        expect(metrics.range).toBe(200);
        expect(Math.abs(metrics.offset)).toBe(scrolled ? 50 : 0);
        expect(Math.abs(metrics.overlap - overlap)).toBeLessThanOrEqual(1);
        await expect(
          page.getByRole("button", { name: "Viewport nested" }),
        ).not.toBeInViewport();
        const problems = await findPhoneLayoutProblems(page);
        expect(problems.includes("cut-off controls:")).toBe(overlap < 30);
        if (overlap < 30) {
          expect(problems).toContainEqual(
            expect.stringContaining('button "Viewport nested"'),
          );
        }
      });
    }
  }
}

for (const { axis, direction, targetOffset } of nestedScrollAxes) {
  for (const scrolled of [false, true]) {
    test(`nested ${direction} ${axis} scrolling can reveal an inner scroller ${scrolled ? "after scrolling" : "at origin"}`, async ({
      page,
    }) => {
      const innerOffset = direction === "rtl" ? -180 : 180;
      // safe-html: static nested controls with enumerated geometry fixture values.
      await setPhoneContent(
        page,
        `
        <style>
          #outer { position: absolute; left: 50px; top: 50px; width: 100px; height: 100px; overflow: auto; direction: ${direction}; }
          #outer-extent, #inner-extent { position: absolute; left: ${direction === "rtl" ? -200 : 0}px; top: 0; width: ${axis === "x" ? 300 : 1}px; height: ${axis === "y" ? 300 : 1}px; }
          #inner { position: absolute; left: ${axis === "x" ? innerOffset : 0}px; top: ${axis === "y" ? innerOffset : 0}px; width: 100px; height: 100px; overflow: auto; direction: ${direction}; }
          button { position: absolute; left: ${axis === "x" ? targetOffset : 20}px; top: ${axis === "y" ? targetOffset : 20}px; width: 30px; height: 30px; }
        </style>
        <div id="outer"><div id="outer-extent"></div><div id="inner"><div id="inner-extent"></div><button aria-label="Reachable nested"></button></div></div>
      `,
      );
      for (const selector of ["#inner", "#outer"]) {
        const metrics = await page.locator(selector).evaluate(
          (box, fixture) => {
            if (fixture.scrolled) {
              box.scrollLeft = fixture.direction === "rtl" ? -50 : 50;
              box.scrollTop = 50;
            }
            return {
              range:
                fixture.axis === "x"
                  ? box.scrollWidth - box.clientWidth
                  : box.scrollHeight - box.clientHeight,
              offset: fixture.axis === "x" ? box.scrollLeft : box.scrollTop,
            };
          },
          { axis, direction, scrolled },
        );
        expect(metrics.range).toBe(200);
        expect(Math.abs(metrics.offset)).toBe(scrolled ? 50 : 0);
      }
      await expect(
        page.getByRole("button", { name: "Reachable nested" }),
      ).not.toBeInViewport();
      expect(await findPhoneLayoutProblems(page)).toEqual([]);
    });
  }
}

for (const scrolled of [false, true]) {
  test(`normal page scrolling can reveal a below-screen inner scroller ${scrolled ? "after scrolling" : "at origin"}`, async ({
    page,
  }) => {
    // safe-html: static below-screen control in a normal scrolling document.
    await setPhoneContent(
      page,
      `
      <style>
        html, body { margin: 0; }
        #inner { position: absolute; left: 50px; top: 120vh; width: 100px; height: 100px; overflow: auto; }
        #extent { width: 1px; height: 300px; }
        button { position: absolute; left: 20px; top: 200px; width: 30px; height: 30px; }
      </style>
      <div id="inner"><div id="extent"></div><button aria-label="Below page"></button></div>
    `,
    );
    const metrics = await page
      .locator("#inner")
      .evaluate((box, fixtureScrolled) => {
        box.scrollTop = fixtureScrolled ? 50 : 0;
        return {
          range: box.scrollHeight - box.clientHeight,
          offset: box.scrollTop,
          belowScreen: box.getBoundingClientRect().top > window.innerHeight,
        };
      }, scrolled);
    expect(metrics.range).toBe(200);
    expect(metrics.offset).toBe(scrolled ? 50 : 0);
    expect(metrics.belowScreen).toBe(true);
    expect(await findPhoneLayoutProblems(page)).toEqual([]);
  });
}

for (const { name, css, containingBlock } of [
  { name: "ordinary wrapper", css: "", containingBlock: false },
  { name: "transform", css: "transform:translateZ(0)", containingBlock: true },
  { name: "translate", css: "translate:0px", containingBlock: true },
  { name: "rotate", css: "rotate:0deg", containingBlock: true },
  { name: "scale", css: "scale:1", containingBlock: true },
  { name: "perspective", css: "perspective:1000px", containingBlock: true },
  { name: "filter", css: "filter:blur(0px)", containingBlock: true },
  {
    name: "backdrop filter",
    css: "backdrop-filter:blur(0px)",
    containingBlock: true,
  },
  { name: "layout containment", css: "contain:layout", containingBlock: true },
  { name: "paint containment", css: "contain:paint", containingBlock: true },
  {
    name: "will-change transform",
    css: "will-change:transform",
    containingBlock: true,
  },
  {
    name: "will-change filter",
    css: "will-change:filter",
    containingBlock: true,
  },
]) {
  test(`fixed control respects its actual containing block: ${name}`, async ({
    page,
  }) => {
    // safe-html: static fixed control with enumerated containing-block fixture CSS.
    await setPhoneContent(
      page,
      `
      <style>
        #wrapper { position: absolute; left: 50px; top: 50px; width: 100px; height: 100px; overflow: hidden; ${css}; }
        button { position: fixed; left: 200px; top: 80px; width: 30px; height: 30px; }
      </style>
      <div id="wrapper"><button aria-label="Fixed"></button></div>
    `,
    );
    const metrics = await page
      .getByRole("button", { name: "Fixed" })
      .evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          hit:
            document.elementFromPoint(rect.left + 15, rect.top + 15) === button,
        };
      });
    expect(metrics.left).toBe(containingBlock ? 250 : 200);
    expect(metrics.top).toBe(containingBlock ? 130 : 80);
    expect(metrics.hit).toBe(!containingBlock);
    const problems = await findPhoneLayoutProblems(page);
    expect(problems.includes("cut-off controls:")).toBe(containingBlock);
    expect(problems).toHaveLength(containingBlock ? 2 : 0);
  });
}

for (const fixedOwner of ["control", "ancestor"]) {
  for (const containingBlock of [false, true]) {
    test(`fixed ${fixedOwner} escapes an ordinary clipping wrapper ${containingBlock ? "inside a containing block" : "in the viewport"}`, async ({
      page,
    }) => {
      // safe-html: static fixed control with enumerated positioning fixture CSS.
      await setPhoneContent(
        page,
        `
        <style>
          #container { position: absolute; left: 50px; top: 50px; width: 200px; height: 200px; ${containingBlock ? "transform:translateZ(0);overflow:hidden" : ""}; }
          #wrapper { position: absolute; left: 0; top: 0; width: 30px; height: 30px; overflow: hidden; }
          #anchor { position: ${fixedOwner === "ancestor" ? "fixed" : "static"}; left: 100px; top: 60px; width: 50px; height: 50px; }
          button { position: ${fixedOwner === "control" ? "fixed" : "absolute"}; left: ${fixedOwner === "control" ? 100 : 0}px; top: ${fixedOwner === "control" ? 60 : 0}px; width: 30px; height: 30px; }
        </style>
        <div id="container"><div id="wrapper"><div id="anchor"><button aria-label="Escaped"></button></div></div></div>
      `,
      );
      const metrics = await page
        .getByRole("button", { name: "Escaped" })
        .evaluate((button) => {
          const rect = button.getBoundingClientRect();
          return {
            left: rect.left,
            top: rect.top,
            hit:
              document.elementFromPoint(rect.left + 15, rect.top + 15) ===
              button,
          };
        });
      expect(metrics.left).toBe(containingBlock ? 150 : 100);
      expect(metrics.top).toBe(containingBlock ? 110 : 60);
      expect(metrics.hit).toBe(true);
      expect(await findPhoneLayoutProblems(page)).toEqual([]);
    });
  }
}

test("a fixed containing block remains constrained by its outer clipping ancestor", async ({
  page,
}) => {
  // safe-html: static fixed control in a clipped containing block.
  await setPhoneContent(
    page,
    `
    <style>
      #outer { position: absolute; left: 50px; top: 50px; width: 100px; height: 100px; overflow: hidden; }
      #container { position: absolute; left: 120px; top: 0; width: 100px; height: 100px; transform:translateZ(0); }
      button { position: fixed; left: 20px; top: 20px; width: 30px; height: 30px; }
    </style>
    <div id="outer"><div id="container"><button aria-label="Outer clipped fixed"></button></div></div>
  `,
  );
  const metrics = await page
    .getByRole("button", { name: "Outer clipped fixed" })
    .evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        hit:
          document.elementFromPoint(rect.left + 15, rect.top + 15) === button,
      };
    });
  expect(metrics).toEqual({ left: 190, top: 70, hit: false });
  expect(await findPhoneLayoutProblems(page)).toEqual([
    "cut-off controls:",
    '  button "Outer clipped fixed" is cut off at the side of div',
  ]);
});

for (const scrolled of [false, true]) {
  test(`a document can scroll a fixed containing block into view ${scrolled ? "after scrolling" : "at origin"}`, async ({
    page,
  }) => {
    // safe-html: static fixed control in a below-screen containing block.
    await setPhoneContent(
      page,
      `
      <style>
        html, body { margin: 0; min-height: 200vh; }
        #container { position: absolute; left: 50px; top: 120vh; width: 100px; height: 100px; transform:translateZ(0); overflow:hidden; }
        button { position: fixed; left: 20px; top: 20px; width: 30px; height: 30px; }
      </style>
      <div id="container"><button aria-label="Moving fixed"></button></div>
    `,
    );
    const initial = await page
      .getByRole("button", { name: "Moving fixed" })
      .evaluate((button) => ({
        top: button.getBoundingClientRect().top,
        viewportHeight: window.innerHeight,
      }));
    expect(initial.top).toBeGreaterThan(initial.viewportHeight);
    if (scrolled) {
      await page.evaluate((top) => window.scrollTo(0, top - 100), initial.top);
    }
    const metrics = await page
      .getByRole("button", { name: "Moving fixed" })
      .evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return {
          top: rect.top,
          scroll: window.scrollY,
          hit:
            document.elementFromPoint(rect.left + 15, rect.top + 15) === button,
        };
      });
    expect(
      Math.abs(initial.top - metrics.top - metrics.scroll),
    ).toBeLessThanOrEqual(1);
    expect(metrics.scroll > 0).toBe(scrolled);
    expect(metrics.hit).toBe(scrolled);
    expect(await findPhoneLayoutProblems(page)).toEqual([]);
  });
}

for (const placement of ["document", "nested scroller"]) {
  for (const scrolled of [false, true]) {
    test(`an invisible reachable control below the ${placement} fold is reported ${scrolled ? "after scrolling" : "at origin"}`, async ({
      page,
    }) => {
      // safe-html: static transparent control with enumerated scrolling fixture CSS.
      await setPhoneContent(
        page,
        `
        <style>
          html, body { margin: 0; min-height: 200vh; }
          #region { position: absolute; left: 50px; top: 120vh; width: 100px; height: 100px; ${placement === "nested scroller" ? "overflow:auto" : ""}; }
          #extent { width: 1px; height: 300px; }
          button { position: absolute; left: 20px; top: ${placement === "nested scroller" ? 200 : 0}px; width: 40px; height: 40px; opacity:0; }
        </style>
        <div id="region"><div id="extent"></div><button aria-label="Hidden below fold"></button></div>
      `,
      );
      if (scrolled) {
        await page.evaluate(() => window.scrollTo(0, 50));
        await page.locator("#region").evaluate((box) => {
          box.scrollTop = 50;
        });
      }
      const metrics = await page
        .getByRole("button", { name: "Hidden below fold" })
        .evaluate((button) => ({
          top: button.getBoundingClientRect().top,
          viewportHeight: window.innerHeight,
          scroll: window.scrollY,
          opacity: getComputedStyle(button).opacity,
        }));
      expect(metrics.top).toBeGreaterThan(metrics.viewportHeight);
      expect(metrics.scroll).toBe(scrolled ? 50 : 0);
      expect(metrics.opacity).toBe("0");
      if (placement === "nested scroller") {
        await expect(page.locator("#region")).toHaveJSProperty(
          "scrollHeight",
          300,
        );
        await expect(page.locator("#region")).toHaveJSProperty(
          "scrollTop",
          scrolled ? 50 : 0,
        );
      }
      expect(await findPhoneLayoutProblems(page)).toEqual([
        "hover-only controls:",
        '  button "Hidden below fold" is invisible until hovered',
      ]);
    });
  }
}

for (const hidden of ['aria-hidden="true"', "inert"]) {
  test(`an explicitly hidden below-fold region ${hidden} excludes invisible controls`, async ({
    page,
  }) => {
    // safe-html: static transparent control with enumerated hiding fixture attributes.
    await setPhoneContent(
      page,
      `
      <style>
        body { min-height: 200vh; }
        #region { position: absolute; left: 50px; top: 120vh; width: 100px; height: 100px; }
        button { width: 40px; height: 40px; opacity:0; }
      </style>
      <div id="region" ${hidden}><button aria-label="Intentionally hidden"></button></div>
    `,
    );
    const metrics = await page.locator("button").evaluate((button) => ({
      top: button.getBoundingClientRect().top,
      viewportHeight: window.innerHeight,
      width: button.getBoundingClientRect().width,
    }));
    expect(metrics.top).toBeGreaterThan(metrics.viewportHeight);
    expect(metrics.width).toBe(40);
    expect(await findPhoneLayoutProblems(page)).toEqual([]);
  });
}

for (const proxy of ["none", "label", "painted sibling"]) {
  for (const scrolled of [false, true]) {
    test(`a transparent below-fold native field requires a reachable ${proxy} proxy ${scrolled ? "after scrolling" : "at origin"}`, async ({
      page,
    }) => {
      // safe-html: static native field with enumerated below-screen proxy markup.
      await setPhoneContent(
        page,
        `
        <style>
          html, body { margin: 0; min-height: 200vh; }
          #region { position: absolute; left: 50px; top: 120vh; width: 100px; height: 100px; }
          input, #proxy { position: absolute; left: 0; top: 0; width: 100px; height: 40px; }
          input { opacity:0; z-index:1; }
          #proxy { background:gray; pointer-events:none; }
          label { position: absolute; top: 60px; }
        </style>
        <div id="region">
          <input id="field" aria-label="Below fold field">
          ${proxy === "label" ? '<label for="field">Proxy</label>' : ""}
          ${proxy === "painted sibling" ? '<span id="proxy">Proxy</span>' : ""}
        </div>
      `,
      );
      if (scrolled) {
        await page.evaluate(() => window.scrollTo(0, 50));
      }
      const metrics = await page.locator("input").evaluate((field) => ({
        top: field.getBoundingClientRect().top,
        viewportHeight: window.innerHeight,
        scroll: window.scrollY,
      }));
      expect(metrics.top).toBeGreaterThan(metrics.viewportHeight);
      expect(metrics.scroll).toBe(scrolled ? 50 : 0);
      if (proxy !== "none") {
        const affordance = await page
          .getByText("Proxy", { exact: true })
          .evaluate((element) => ({
            top: element.getBoundingClientRect().top,
            opacity: getComputedStyle(element).opacity,
            width: element.getBoundingClientRect().width,
          }));
        expect(affordance.top).toBeGreaterThan(metrics.viewportHeight);
        expect(affordance.opacity).toBe("1");
        expect(affordance.width).toBeGreaterThan(1);
      }
      expect(await findPhoneLayoutProblems(page)).toEqual(
        proxy === "none"
          ? [
              "hover-only controls:",
              '  input "Below fold field" is invisible until hovered',
            ]
          : [],
      );
    });
  }
}
