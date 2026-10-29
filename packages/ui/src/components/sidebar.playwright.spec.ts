import { expect, type Page, test } from "@playwright/test";

const fixturePath = "/src/components/fixtures/sidebar.fixture.html";
const VIEWPORT = { width: 844, height: 390 };

test("the mobile popup owns surface props and exposes its inner panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${fixturePath}?dir=ltr&side=left&variant=sidebar&inset=zero`,
  );
  await page.addStyleTag({
    content: ".isolate [data-slot=sidebar-inner] { outline-style: dashed; }",
  });
  await page.getByRole("button", { name: "Toggle fixture sidebar" }).click();
  const popup = page.getByRole("dialog");
  await expect(popup).toHaveAttribute("data-surface", "matter");
  await expect(popup).toHaveCSS("opacity", "0.9");
  await expect(popup).toHaveCSS("isolation", "isolate");
  await expect(popup.locator('[data-slot="sidebar-inner"]')).toHaveCSS(
    "outline-style",
    "dashed",
  );
});

type Direction = "ltr" | "rtl";
type Side = "left" | "right";
type Variant = "sidebar" | "floating" | "inset";

type OpenFixtureOptions = {
  page: Page;
  direction: Direction;
  side: Side;
  variant: Variant;
  inset: "zero" | "safe";
};

const openFixture = async ({
  page,
  direction,
  side,
  variant,
  inset,
}: OpenFixtureOptions) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto(
    `${fixturePath}?dir=${direction}&side=${side}&variant=${variant}&inset=${inset}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; }",
  });
};

const readGeometry = async (page: Page) =>
  page.evaluate(() => {
    const required = (selector: string) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Missing fixture geometry element: ${selector}`);
      }
      return element;
    };
    const rect = (element: Element) => element.getBoundingClientRect();
    const sidebar = required('[data-slot="sidebar"][data-side]');
    const gap = required('[data-slot="sidebar-gap"]');
    const container = required('[data-slot="sidebar-container"]');
    const inner = required('[data-slot="sidebar-inner"]');
    const main = required('[data-testid="main-content"]');
    const direction = document.documentElement.dir;
    const side = sidebar.dataset["side"];
    const atPhysicalStart =
      (side === "left" && direction === "ltr") ||
      (side === "right" && direction === "rtl");
    const viewWidth = document.documentElement.clientWidth;
    const contentEdge = (box: DOMRect) =>
      atPhysicalStart ? box.right : box.left;
    const clippingAncestors = (element: Element) => {
      const ancestors: Element[] = [];
      let ancestor = element.parentElement;
      while (ancestor !== null) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX !== "visible" || style.overflowY !== "visible") {
          ancestors.push(ancestor);
        }
        ancestor = ancestor.parentElement;
      }
      return ancestors;
    };
    const innerBox = rect(inner);
    const buttonBoxes = Array.from(
      document.querySelectorAll('[data-slot="sidebar-menu-button"]'),
    ).map((button) => {
      const box = rect(button);
      const clips = clippingAncestors(button);
      const insideClips = clips.every((ancestor) => {
        const clipBox = rect(ancestor);
        const style = getComputedStyle(ancestor);
        const clipsX =
          style.overflowX === "hidden" ||
          style.overflowX === "clip" ||
          style.overflowX === "auto" ||
          style.overflowX === "scroll";
        const clipsY =
          style.overflowY === "hidden" ||
          style.overflowY === "clip" ||
          style.overflowY === "auto" ||
          style.overflowY === "scroll";
        return (
          (!clipsX ||
            (box.left >= clipBox.left && box.right <= clipBox.right)) &&
          (!clipsY || (box.top >= clipBox.top && box.bottom <= clipBox.bottom))
        );
      });
      return {
        label: button.getAttribute("aria-label") ?? "unnamed",
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        insideInner: box.left >= innerBox.left && box.right <= innerBox.right,
        insideClips:
          insideClips &&
          box.left >= 0 &&
          box.right <= viewWidth &&
          box.top >= 0 &&
          box.bottom <= document.documentElement.clientHeight,
      };
    });
    const gapBox = rect(gap);
    const containerBox = rect(container);
    const mainBox = rect(main);
    return {
      innerWidth: innerBox.width,
      gapWidth: gapBox.width,
      containerWidth: containerBox.width,
      gapContentEdge: contentEdge(gapBox),
      containerContentEdge: contentEdge(containerBox),
      mainLeft: mainBox.left,
      mainRight: mainBox.right,
      buttons: buttonBoxes,
    };
  });

type Geometry = Awaited<ReturnType<typeof readGeometry>>;

const captureBothStates = async (page: Page) => {
  const sidebar = page.locator('[data-slot="sidebar"][data-side]');
  const toggle = page.getByRole("button", { name: "Toggle fixture sidebar" });
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  const collapsed = await readGeometry(page);
  await toggle.click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  const expanded = await readGeometry(page);
  await toggle.click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  return { collapsed, expanded };
};

const assertButtonsAreSafe = (geometry: Geometry, label: string) => {
  expect(geometry.buttons).toHaveLength(2);
  for (const button of geometry.buttons) {
    expect(
      button.insideInner,
      `${label}: ${button.label} stays inside the visible sidebar inner box`,
    ).toBe(true);
    expect(
      button.insideClips,
      `${label}: ${button.label} stays inside clipping ancestors and viewport`,
    ).toBe(true);
    const overlapsMain =
      button.left < geometry.mainRight && button.right > geometry.mainLeft;
    expect(
      overlapsMain,
      `${label}: ${button.label} does not cross into adjacent main content`,
    ).toBe(false);
  }
  const [first, second] = geometry.buttons;
  if (first === undefined || second === undefined) {
    throw new Error("Expected both fixture menu buttons");
  }
  const overlap =
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top;
  expect(overlap, `${label}: menu buttons do not overlap each other`).toBe(
    false,
  );
};

for (const direction of ["ltr", "rtl"] as const) {
  for (const side of ["left", "right"] as const) {
    for (const variant of ["sidebar", "floating", "inset"] as const) {
      test(`${variant} sidebar clears safe-area insets on logical ${side} in ${direction}`, async ({
        page,
      }) => {
        await openFixture({ page, direction, side, variant, inset: "zero" });
        const baseline = await captureBothStates(page);

        await openFixture({ page, direction, side, variant, inset: "safe" });
        const insetGeometry = await captureBothStates(page);
        const attachedInset = side === "left" ? 44 : 28;
        const docksAtPhysicalStart =
          (side === "left" && direction === "ltr") ||
          (side === "right" && direction === "rtl");

        for (const state of ["collapsed", "expanded"] as const) {
          const base = baseline[state];
          const safe = insetGeometry[state];
          const label = `${variant}/${side}/${direction}/${state}`;
          expect(
            safe.innerWidth,
            `${label}: safe-area padding preserves usable inner width`,
          ).toBeCloseTo(base.innerWidth, 0);
          expect(
            safe.gapWidth - base.gapWidth,
            `${label}: layout gap grows by the attached logical inset`,
          ).toBeCloseTo(attachedInset, 0);
          expect(
            Math.abs(safe.gapContentEdge - safe.containerContentEdge),
            `${label}: gap and container content edges differ by at most the two-pixel gutter`,
          ).toBeLessThanOrEqual(2);
          if (docksAtPhysicalStart) {
            expect(
              safe.gapContentEdge,
              `${label}: gap content edge leaves room before main content`,
            ).toBeLessThanOrEqual(safe.mainLeft);
          } else {
            expect(
              safe.gapContentEdge,
              `${label}: gap content edge leaves room before main content`,
            ).toBeGreaterThanOrEqual(safe.mainRight);
          }
          assertButtonsAreSafe(base, `${label}/zero-inset`);
          assertButtonsAreSafe(safe, label);
          console.info("sidebar geometry", {
            direction,
            side,
            variant,
            state,
            baselineInnerWidth: base.innerWidth,
            insetInnerWidth: safe.innerWidth,
            baselineGapWidth: base.gapWidth,
            insetGapWidth: safe.gapWidth,
            attachedInset,
            containerWidth: safe.containerWidth,
          });
        }
      });
    }
  }
}
