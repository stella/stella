import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import {
  engineParityCases,
  engineParityOutputDirectory,
  engineParityXmlDigests,
} from "@/api/tests/helpers/docx-engine-parity";

import { fillTemplate } from "./patch-template";

test("clause-free templates preserve every XML part recorded from main", async () => {
  const cases = await engineParityCases();
  expect(
    (await readdir(engineParityOutputDirectory))
      .filter((name) => name.endsWith(".json"))
      .toSorted(),
  ).toEqual(cases.map(({ name }) => `${name}.json`).toSorted());
  for (const { name, file, values } of cases) {
    const result = await fillTemplate(file, values);
    expect(result.structureErrors).toEqual([]);
    expect(await engineParityXmlDigests(result.file)).toBe(
      await Bun.file(
        new URL(`${name}.json`, engineParityOutputDirectory),
      ).text(),
    );
  }
});
