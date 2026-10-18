import { expect, test } from "bun:test";

import type { VatRateCommand } from "./vat-rates";

test("country preset commands carry a supported country", () => {
  const commands = [
    { type: "applyPreset", country: "SK" },
    { type: "applyPreset", country: "CZ" },
  ] as const satisfies readonly VatRateCommand[];
  expect(commands.map(({ country }) => country)).toEqual(["SK", "CZ"]);
});
