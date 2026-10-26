/**
 * The cited-provision header, the shared peek header, keeps to one row,
 * keeps its actions, and gives way in order.
 *
 * Measured on the bench at `/dev?visual=provision-header`, which draws the
 * product's own header with a label naming three cited parts at widths from
 * a roomy card down to one narrower than the label alone. At every width:
 * the row is one line, every action lies inside the card, the first is what
 * a click at its centre hits, the date gives way only once the act's
 * title is gone, and the label is cut only once the date is gone. Every
 * project runs it, so it holds right to left (`ar`) as well.
 */

import type { Page } from "@playwright/test";

import {
  expect,
  test,
  waitForStableGeometry,
} from "../helpers/stable-geometry";

const SECTION = '[data-playground-section="provision-header"]';
const BENCH_WIDTHS = [120, 180, 240, 300, 360, 440, 560, 720];
const BENCH_LABEL = "§ 226 odst. 1, § 226 odst. 2, § 226 odst. 3";

/** Sub-pixel rounding is not a part giving way. */
const TOLERANCE_PX = 1;

type HeaderGeometry = {
  width: number;
  /** Whether the act's title is cut, and how much of it is left. */
  actTruncated: boolean;
  actWidth: number;
  buttonHit: boolean;
  buttonInside: boolean;
  /** Whether the date is cut, and how much of it is left. */
  dateTruncated: boolean;
  dateWidth: number;
  labelTitle: string | null;
  labelTruncated: boolean;
  oneRow: boolean;
};

const readGeometry = async (page: Page): Promise<HeaderGeometry[]> => {
  await waitForStableGeometry(page, page.locator(SECTION));
  return await page.evaluate(
    ({ sectionSelector, tolerance }) => {
      const part = (section: Element, selector: string): HTMLElement => {
        const element = section.querySelector(selector);
        if (!(element instanceof HTMLElement)) {
          throw new Error(`provision header bench is missing ${selector}`);
        }
        return element;
      };
      return [...document.querySelectorAll(sectionSelector)].map((section) => {
        if (!(section instanceof HTMLElement)) {
          throw new Error("provision header bench section is not an element");
        }
        const header = part(section, '[data-slot="reference-peek-header"]');
        const summary = part(section, '[data-slot="reference-peek-summary"]');
        const label = part(section, '[data-slot="reference-peek-primary"]');
        const act = part(
          section,
          '[data-slot="reference-peek-meta"][data-part="act"]',
        );
        const date = part(
          section,
          '[data-slot="reference-peek-meta"][data-part="date"]',
        );
        const actions = part(section, '[data-slot="reference-peek-actions"]');
        const button = header.querySelector("button");
        if (!(button instanceof HTMLElement)) {
          throw new Error("provision header bench is missing its open button");
        }
        const card = section.getBoundingClientRect();
        const box = button.getBoundingClientRect();
        const actionsBox = actions.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        );
        return {
          width: Number(section.dataset["headerWidth"]),
          actTruncated: act.scrollWidth > act.clientWidth,
          actWidth: act.getBoundingClientRect().width,
          buttonHit: hit !== null && button.contains(hit),
          buttonInside:
            box.width > 0 &&
            box.left >= card.left - tolerance &&
            box.right <= card.right + tolerance &&
            actionsBox.left >= card.left - tolerance &&
            actionsBox.right <= card.right + tolerance,
          dateTruncated: date.scrollWidth > date.clientWidth,
          dateWidth: date.getBoundingClientRect().width,
          labelTitle: label.getAttribute("title"),
          labelTruncated: label.scrollWidth > label.clientWidth,
          oneRow:
            header.getBoundingClientRect().height <= box.height + tolerance &&
            summary.scrollHeight <= summary.clientHeight + tolerance,
        };
      });
    },
    { sectionSelector: SECTION, tolerance: TOLERANCE_PX },
  );
};

test("header measurements wait for a moving button inside a fixed section", async ({
  page,
}) => {
  await page.goto("/dev?visual=provision-header", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator(SECTION)).toHaveCount(BENCH_WIDTHS.length);
  const section = page.locator(SECTION).first();
  const button = section
    .locator('[data-slot="reference-peek-header"] button')
    .first();
  await expect(button).toBeVisible();
  const before = await readGeometry(page);
  expect(before.at(0)?.buttonInside).toBe(true);
  const sectionBefore = await section.evaluate((element) =>
    element.getBoundingClientRect().toJSON(),
  );
  const animationId = "geometry-header-button-motion";
  await button.evaluate(
    (element, { id, sectionSelector }) => {
      const parent = element.closest(sectionSelector);
      if (parent === null) {
        throw new Error("Provision button has no bench section");
      }
      const card = parent.getBoundingClientRect();
      const target = element.getBoundingClientRect();
      const nearestEdgeIsLeft =
        target.left - card.left < card.right - target.right;
      const distance = nearestEdgeIsLeft
        ? card.left - target.right - 1
        : card.right - target.left + 1;
      const motion = element.animate(
        [
          { transform: "translateX(0px)" },
          { transform: `translateX(${distance}px)` },
        ],
        // The delay holds the button still while the animation already runs,
        // as a pending start does on a slow frame.
        { delay: 500, duration: 1000, easing: "linear", fill: "forwards" },
      );
      motion.id = id;
    },
    { id: animationId, sectionSelector: SECTION },
  );
  try {
    const after = await readGeometry(page);
    expect(
      await button.evaluate(
        (element, id) =>
          element.getAnimations().find((motion) => motion.id === id)?.playState,
        animationId,
      ),
    ).toBe("finished");
    expect(
      await section.evaluate((element) =>
        element.getBoundingClientRect().toJSON(),
      ),
    ).toEqual(sectionBefore);
    expect(after.at(0)?.buttonInside).toBe(false);
  } finally {
    await button.evaluate((element, id) => {
      for (const motion of element.getAnimations()) {
        if (motion.id === id) {
          motion.cancel();
        }
      }
    }, animationId);
  }
});

test("the header keeps one row and its open button, and gives way act first, then date, then label", async ({
  page,
}) => {
  await page.goto("/dev?visual=provision-header", { waitUntil: "commit" });
  await expect(page.locator(SECTION)).toHaveCount(BENCH_WIDTHS.length);
  await expect(
    page.locator(`${SECTION} [data-part="date"]`).first(),
  ).toBeVisible();

  const headers = await readGeometry(page);
  expect(headers.map(({ width }) => width).toSorted((a, b) => a - b)).toEqual(
    BENCH_WIDTHS,
  );

  for (const header of headers) {
    const at = `at ${String(header.width)}px`;
    expect(header.oneRow, `${at} the header is one row`).toBe(true);
    expect(
      header.buttonInside,
      `${at} the open button is inside the card`,
    ).toBe(true);
    expect(header.buttonHit, `${at} a click reaches the open button`).toBe(
      true,
    );
    expect(header.labelTitle, `${at} the label keeps its full text`).toBe(
      BENCH_LABEL,
    );
    if (header.dateTruncated) {
      expect(
        header.actWidth,
        `${at} the date gives way only once the act's title is gone`,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
    }
    if (header.labelTruncated) {
      expect(
        header.dateWidth,
        `${at} the label is cut only once the date is gone`,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
    }
  }

  // A vacuous pass is the failure mode to rule out: the bench must reach
  // every stage, or the order above was never under test.
  expect(
    headers.some(
      (header) =>
        !header.actTruncated && !header.dateTruncated && !header.labelTruncated,
    ),
    "some width shows the whole header",
  ).toBe(true);
  expect(
    headers.some(
      (header) =>
        header.actTruncated &&
        header.actWidth > TOLERANCE_PX &&
        !header.dateTruncated,
    ),
    "some width cuts only the act's title",
  ).toBe(true);
  expect(
    headers.some(
      (header) =>
        header.dateTruncated &&
        header.dateWidth > TOLERANCE_PX &&
        !header.labelTruncated,
    ),
    "some width cuts the date and keeps the whole label",
  ).toBe(true);
  expect(
    headers.some((header) => header.labelTruncated),
    "some width is narrower than the label alone",
  ).toBe(true);
});
