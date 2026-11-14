declare const page: {
  waitForTimeout: (ms: number) => Promise<void>;
  setViewportSize: (size: { width: number; height: number }) => Promise<void>;
};
declare const locator: { boundingBox: () => Promise<unknown> };
declare const stableBoundingBox: (
  measuredPage: typeof page,
  measuredLocator: typeof locator,
) => Promise<unknown>;

// oxlint-disable-next-line require-stable-geometry/require-stable-geometry -- fixture exercises the rejected sleep
void page.waitForTimeout(100);
// oxlint-disable-next-line require-stable-geometry/require-stable-geometry -- fixture exercises direct viewport changes
void page.setViewportSize({ width: 800, height: 600 });
// oxlint-disable-next-line require-stable-geometry/require-stable-geometry -- fixture exercises direct measurement
void locator.boundingBox();

// expect-clean: require-stable-geometry/require-stable-geometry
void stableBoundingBox(page, locator);
