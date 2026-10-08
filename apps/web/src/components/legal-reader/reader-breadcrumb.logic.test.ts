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
    }),
  ).toEqual([60, 100, 100]);
  expect(
    fitReaderPath({
      available: 190,
      naturalWidths: [100, 100, 100],
      minimumWidths: [44, 44, 50],
    }),
  ).toEqual([44, 46, 100]);
  expect(
    fitReaderPath({
      available: 138,
      naturalWidths: [100, 100, 100],
      minimumWidths: [44, 44, 50],
    }),
  ).toEqual([44, 44, 50]);
  expect(readerProvisionNumber("§ 5 Žádost o poskytnutí přímé platby")).toBe(
    "§ 5",
  );
  expect(readerProvisionNumber("§ 12a Další ustanovení")).toBe("§ 12a");
  expect(readerProvisionNumber("Odůvodnění")).toBeNull();
  expect(readerProvisionNumber("Žádost o platbu\n§ 5")).toBe("§ 5");
  expect(readerProvisionNumber("Posouzení § 5")).toBeNull();
});
