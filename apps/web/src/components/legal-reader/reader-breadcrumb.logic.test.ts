import { expect, test } from "bun:test";

import {
  compactReaderPath,
  fitReaderPath,
  fitWidth,
  readerProvisionNumber,
  splitReaderHeading,
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

test("reader breadcrumb finds the provision number a heading opens with", () => {
  expect(readerProvisionNumber("§ 5 Žádost o poskytnutí přímé platby")).toBe(
    "§ 5",
  );
  expect(readerProvisionNumber("§ 12a Další ustanovení")).toBe("§ 12a");
  expect(readerProvisionNumber("Odůvodnění")).toBeNull();
  expect(readerProvisionNumber("Žádost o platbu\n§ 5")).toBe("§ 5");
  expect(readerProvisionNumber("Posouzení § 5")).toBeNull();
});

test("a heading splits into the label a reader navigates by and its title", () => {
  expect(
    splitReaderHeading(
      "HLAVA III\nPODPORA ELEKTŘINY Z OBNOVITELNÝCH ZDROJŮ A DRUHOTNÝCH ZDROJŮ",
    ),
  ).toEqual({
    label: "HLAVA III",
    title: "PODPORA ELEKTŘINY Z OBNOVITELNÝCH ZDROJŮ A DRUHOTNÝCH ZDROJŮ",
  });
  expect(splitReaderHeading("§ 7\nPráva a povinnosti subjektů")).toEqual({
    label: "§ 7",
    title: "Práva a povinnosti subjektů",
  });
  expect(splitReaderHeading("§ 5 Žádost o poskytnutí přímé platby")).toEqual({
    label: "§ 5",
    title: "Žádost o poskytnutí přímé platby",
  });
  expect(splitReaderHeading("Žádost o platbu\n§ 5")).toEqual({
    label: "§ 5",
    title: "Žádost o platbu",
  });
  expect(splitReaderHeading("§ 3a")).toEqual({ label: "§ 3a", title: null });
  expect(splitReaderHeading("Odůvodnění")).toEqual({
    label: "Odůvodnění",
    title: null,
  });
  expect(splitReaderHeading("ČÁST PRVNÍ\nPODPOROVANÉ\nZDROJE")).toEqual({
    label: "ČÁST PRVNÍ",
    title: "PODPOROVANÉ ZDROJE",
  });
});

// ČÁST PRVNÍ / HLAVA III / § 7, each with a long title.
const crumbs = [
  { label: 80, full: 300 },
  { label: 70, full: 800 },
  { label: 30, full: 820 },
];
const fit = (available: number, hiddenCount = 0) =>
  fitReaderPath({
    available,
    crumbs,
    hiddenCount,
    separatorWidth: 16,
    menuWidth: 44,
    minimumTitleWidth: 80,
    maximumAncestorLabelWidth: 160,
  });

test("reader breadcrumb gives way in order: outer titles, current title, outer levels, current label", () => {
  expect(fit(2000)).toEqual({
    fits: [
      { type: "full", width: 300 },
      { type: "full", width: 800 },
      { type: "full", width: 820 },
    ],
    showMenu: false,
  });
  // The outermost title goes first, then the next one is cut.
  expect(fit(1100).fits).toEqual([
    { type: "label", width: 80 },
    { type: "full", width: 168 },
    { type: "full", width: 820 },
  ]);
  // Outer levels as labels alone; the current title cut to what is left.
  expect(fit(400).fits).toEqual([
    { type: "label", width: 80 },
    { type: "label", width: 70 },
    { type: "full", width: 218 },
  ]);
  // Outer levels fold into the menu, and the current title takes the slack.
  expect(fit(250)).toEqual({
    fits: [
      { type: "folded" },
      { type: "folded" },
      { type: "full", width: 190 },
    ],
    showMenu: true,
  });
  // Too narrow for any title: the current label alone.
  expect(fit(120).fits.at(-1)).toEqual({ type: "label", width: 30 });
  // Narrower still: the current label itself is cut.
  expect(fit(70).fits.at(-1)).toEqual({ type: "label", width: 10 });
});

test("reader breadcrumb never overflows and keeps the current heading longest", () => {
  for (const hiddenCount of [0, 2]) {
    for (let available = 60; available <= 2100; available += 1) {
      const { fits, showMenu } = fit(available, hiddenCount);
      const shown = fits.filter((entry) => entry.type !== "folded").length;
      const items = shown + (showMenu ? 1 : 0);
      expect(
        fits.reduce((sum, entry) => sum + fitWidth(entry), 0) +
          (showMenu ? 44 : 0) +
          (items - 1) * 16,
      ).toBeLessThanOrEqual(available);
      const current = fits.at(-1);
      expect(current?.type).not.toBe("folded");
      // Folding takes the outermost level first.
      const folded = fits.map((entry) => entry.type === "folded");
      expect(
        folded.every(
          (isFolded, index) => !isFolded || index === 0 || folded[index - 1],
        ),
      ).toBe(true);
      // An outer title is shown only while the current title is.
      if (fits.slice(0, -1).some((entry) => entry.type === "full")) {
        expect(current?.type).toBe("full");
      }
      expect(showMenu).toBe(hiddenCount > 0 || folded.some(Boolean));
    }
  }
});

test("an outer label without a title is capped, the current one is not", () => {
  const { fits } = fitReaderPath({
    available: 2000,
    crumbs: [
      { label: 400, full: 400 },
      { label: 500, full: 500 },
    ],
    hiddenCount: 0,
    separatorWidth: 16,
    menuWidth: 44,
    minimumTitleWidth: 80,
    maximumAncestorLabelWidth: 160,
  });
  expect(fits).toEqual([
    { type: "label", width: 160 },
    { type: "label", width: 500 },
  ]);
});
