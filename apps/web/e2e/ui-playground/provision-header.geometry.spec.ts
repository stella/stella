/**
 * The cited-provision header keeps to one row, keeps its open button, and
 * gives way in order.
 *
 * Measured on the bench at `/dev?visual=provision-header`, which draws the
 * product's own header with a label naming three cited parts at widths from
 * a roomy card down to one narrower than the row's fixed parts. At every
 * width: the row is one line, the open button lies inside the card and is
 * what a click at its centre hits, the label gives way only once the act's
 * title is gone, and the date is cut only once the label is gone. Every
 * project runs it, so it holds right to left (`ar`) as well.
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const SECTION = '[data-playground-section="provision-header"]';
const BENCH_WIDTHS = [72, 120, 180, 240, 300, 360, 440, 560, 720];
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
  dateClipped: boolean;
  labelTitle: string | null;
  labelTruncated: boolean;
  labelWidth: number;
  oneRow: boolean;
};

const readGeometry = async (page: Page): Promise<HeaderGeometry[]> =>
  page.evaluate(
    ({ sectionSelector, tolerance }) => {
      const part = (section: Element, slot: string): HTMLElement => {
        const element = section.querySelector(`[data-slot="${slot}"]`);
        if (!(element instanceof HTMLElement)) {
          throw new Error(`provision header bench is missing ${slot}`);
        }
        return element;
      };
      return [...document.querySelectorAll(sectionSelector)].map((section) => {
        if (!(section instanceof HTMLElement)) {
          throw new Error("provision header bench section is not an element");
        }
        const header = part(section, "provision-card-header");
        const summary = part(section, "provision-card-summary");
        const label = part(section, "provision-card-label");
        const act = part(section, "provision-card-act");
        const date = part(section, "provision-card-date");
        const button = header.querySelector("button");
        if (!(button instanceof HTMLElement)) {
          throw new Error("provision header bench is missing its open button");
        }
        const card = section.getBoundingClientRect();
        const box = button.getBoundingClientRect();
        const inSummary = summary.getBoundingClientRect();
        const dateBox = date.getBoundingClientRect();
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
            box.right <= card.right + tolerance,
          dateClipped:
            dateBox.left < inSummary.left - tolerance ||
            dateBox.right > inSummary.right + tolerance,
          labelTitle: label.getAttribute("title"),
          labelTruncated: label.scrollWidth > label.clientWidth,
          labelWidth: label.getBoundingClientRect().width,
          oneRow:
            header.getBoundingClientRect().height <= box.height + tolerance &&
            summary.scrollHeight <= summary.clientHeight + tolerance,
        };
      });
    },
    { sectionSelector: SECTION, tolerance: TOLERANCE_PX },
  );

test("the header keeps one row and its open button, and gives way act first, then label, then date", async ({
  page,
}) => {
  await page.goto("/dev?visual=provision-header", { waitUntil: "commit" });
  await expect(page.locator(SECTION)).toHaveCount(BENCH_WIDTHS.length);
  await expect(
    page.locator(`${SECTION} [data-slot="provision-card-date"]`).first(),
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
    if (header.labelTruncated) {
      expect(
        header.actWidth,
        `${at} the label gives way only once the act's title is gone`,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
    }
    if (header.dateClipped) {
      expect(
        header.labelWidth,
        `${at} the date is cut only once the label is gone`,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
    }
  }

  // A vacuous pass is the failure mode to rule out: the bench must reach
  // every stage, or the order above was never under test.
  expect(
    headers.some((header) => !header.actTruncated && !header.labelTruncated),
    "some width shows the whole header",
  ).toBe(true);
  expect(
    headers.some(
      (header) =>
        header.actTruncated &&
        header.actWidth > TOLERANCE_PX &&
        !header.labelTruncated,
    ),
    "some width cuts only the act's title",
  ).toBe(true);
  expect(
    headers.some((header) => header.labelTruncated && !header.dateClipped),
    "some width cuts the label and keeps the date",
  ).toBe(true);
});
