import { expect, test } from "bun:test";

import {
  compactReaderPath,
  fitReaderPath,
  readerProvisionNumber,
} from "./reader-breadcrumb.logic";

const path = Array.from({ length: 7 }, (_, index) => ({
  anchorId: `heading-${index}`,
  title: `Heading ${index}`,
}));

test("reader breadcrumb retains three levels and every hidden jump destination", () => {
  for (let length = 0; length <= path.length; length += 1) {
    const input = path.slice(0, length);
    const { visible, hidden } = compactReaderPath(input);
    expect(visible).toHaveLength(Math.min(3, length));
    expect(visible.at(-1)).toEqual(input.at(-1));
    expect(visible.at(0)).toEqual(input.at(0));
    expect([...visible.slice(0, 1), ...hidden, ...visible.slice(1)]).toEqual(
      input,
    );
  }
});

test("reader breadcrumb truncates ancestors first and preserves the current provision number", () => {
  expect(
    fitReaderPath({
      available: 260,
      naturalWidths: [100, 100, 100],
      minimumWidths: [44, 44, 50],
    }).widths,
  ).toEqual([60, 100, 100]);
  expect(
    fitReaderPath({
      available: 190,
      naturalWidths: [100, 100, 100],
      minimumWidths: [44, 44, 50],
    }).widths,
  ).toEqual([44, 46, 100]);
  expect(
    fitReaderPath({
      available: 138,
      naturalWidths: [100, 100, 100],
      minimumWidths: [44, 44, 50],
    }).widths,
  ).toEqual([44, 44, 50]);
  expect(readerProvisionNumber("§ 5 Žádost o poskytnutí přímé platby")).toBe(
    "§ 5",
  );
  expect(readerProvisionNumber("§ 12a Další ustanovení")).toBe("§ 12a");
  expect(readerProvisionNumber("Odůvodnění")).toBeNull();
  expect(readerProvisionNumber("Žádost o platbu\n§ 5")).toBe("§ 5");
  expect(readerProvisionNumber("Posouzení § 5")).toBeNull();
});

test("breadcrumb drops ancestor controls below their total minimum before clipping the current number", () => {
  const fit = (available: number) =>
    fitReaderPath({
      available,
      naturalWidths: [100, 100, 100],
      minimumWidths: [16, 16, 44],
      separatorWidth: 16,
      middleWidth: 60,
    });
  expect(fit(168)).toEqual({ widths: [16, 16, 44], showMiddle: true });
  expect(fit(80)).toEqual({ widths: [0, 16, 48], showMiddle: false });
  expect(fit(60)).toEqual({ widths: [0, 0, 60], showMiddle: false });
  for (let available = 44; available < 168; available += 1) {
    const { widths, showMiddle } = fit(available);
    const reserved =
      (widths.filter((width) => width > 0).length - 1) * 16 +
      (showMiddle ? 60 : 0);
    expect(
      widths.reduce((sum, width) => sum + width, 0) + reserved,
    ).toBeLessThanOrEqual(available);
    expect(widths.at(-1)).toBeGreaterThanOrEqual(44);
  }
});
