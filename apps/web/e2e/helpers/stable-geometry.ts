import { expect, test as base } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const VIEWPORT = { width: 1440, height: 900 } as const;
const STABLE_GEOMETRY_TIMEOUT_MS = 10_000;
const EXPECTED_FONTS = [
  { font: '16px "DM Sans"', text: "Stella č" },
  { font: '16px "Noto Sans Arabic"', text: "العربية" },
] as const;
const MOTION_STYLE_ID = "stable-geometry-motion";

export const test = base.extend({
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
  viewport: VIEWPORT,
});

export { expect };

type Rect = { x: number; y: number; width: number; height: number };

/** Wait for measured roots, their descendant boxes and text lines to settle. */
export const waitForStableGeometry = async (
  page: Page,
  measured: Locator | readonly Locator[],
): Promise<void> => {
  const locators = "elementHandles" in measured ? [measured] : measured;
  await page.evaluate(
    async ({ fonts, styleId }) => {
      const loaded = await Promise.all(
        fonts.map(async ({ font, text }) => ({
          font,
          faces: await document.fonts.load(font, text),
        })),
      );
      await document.fonts.ready;
      const missing = loaded.filter(({ faces }) => faces.length === 0);
      if (missing.length > 0) {
        throw new Error(
          `Stable geometry requires bundled fonts: ${missing.map(({ font }) => font).join(", ")}`,
        );
      }
      if (document.querySelector(`#${styleId}`) === null) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent =
          "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }";
        document.head.append(style);
      }
    },
    { fonts: EXPECTED_FONTS, styleId: MOTION_STYLE_ID },
  );

  await expect
    .poll(
      async () => {
        const results = await Promise.all(
          locators.map(
            async (locator) =>
              await locator.evaluateAll(async (stableElements) => {
                if (stableElements.length === 0) {
                  return false;
                }
                // A just-started animation holds its first frame while it is
                // pending, so equal boxes prove nothing until every finite
                // animation that moves a measured box has ended.
                const moving = document.getAnimations().some((animation) => {
                  const target =
                    animation.effect instanceof KeyframeEffect
                      ? animation.effect.target
                      : null;
                  return (
                    target !== null &&
                    (animation.pending || animation.playState === "running") &&
                    animation.effect?.getComputedTiming().endTime !==
                      Number.POSITIVE_INFINITY &&
                    stableElements.some(
                      (element) =>
                        element.contains(target) || target.contains(element),
                    )
                  );
                });
                if (moving) {
                  return false;
                }
                const snapshot = () => {
                  const elements = new Set(
                    stableElements.flatMap((element) => [
                      element,
                      ...element.querySelectorAll("*"),
                    ]),
                  );
                  return [...elements].map((element) => {
                    const { x, y, width, height } =
                      element.getBoundingClientRect();
                    const textLines = [...element.childNodes].flatMap(
                      (node) => {
                        if (
                          node.nodeType !== Node.TEXT_NODE ||
                          !node.textContent?.trim()
                        ) {
                          return [];
                        }
                        const range = document.createRange();
                        range.selectNodeContents(node);
                        return [...range.getClientRects()].map((rect) => ({
                          x: rect.x,
                          y: rect.y,
                          width: rect.width,
                          height: rect.height,
                        }));
                      },
                    );
                    return {
                      connected: element.isConnected,
                      x,
                      y,
                      width,
                      height,
                      clientWidth: element.clientWidth,
                      clientHeight: element.clientHeight,
                      scrollWidth: element.scrollWidth,
                      scrollHeight: element.scrollHeight,
                      scrollLeft: element.scrollLeft,
                      scrollTop: element.scrollTop,
                      textLines,
                    };
                  });
                };
                const first = snapshot();
                await new Promise<void>((resolve) => {
                  requestAnimationFrame(() => resolve());
                });
                const second = snapshot();
                await new Promise<void>((resolve) => {
                  requestAnimationFrame(() => resolve());
                });
                const third = snapshot();
                return (
                  third.every(({ connected }) => connected) &&
                  JSON.stringify(first) === JSON.stringify(second) &&
                  JSON.stringify(second) === JSON.stringify(third)
                );
              }),
          ),
        );
        return results.every(Boolean);
      },
      {
        message:
          "Geometry did not become stable: expected no running animation on the measured boxes and equal bounding boxes on two consecutive animation frames",
        timeout: STABLE_GEOMETRY_TIMEOUT_MS,
      },
    )
    .toBe(true);
};

/** Read a Playwright box only after its layout is stable. */
export const stableBoundingBox = async (
  page: Page,
  locator: Locator,
): Promise<Rect> => {
  await waitForStableGeometry(page, locator);
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("Stable geometry target has no bounding box");
  }
  return box;
};

/** Assert a CSS-pixel measurement with a tolerance chosen at the call site. */
export const expectGeometry = (
  actualCssPx: number,
  expectedCssPx: number,
  toleranceCssPx: number,
): void => {
  expect(Math.abs(actualCssPx - expectedCssPx)).toBeLessThanOrEqual(
    toleranceCssPx,
  );
};
