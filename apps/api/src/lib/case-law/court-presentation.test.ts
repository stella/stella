import { expect, test } from "bun:test";

import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import {
  courtPresentation,
  readCourtRegistry,
} from "@/api/lib/case-law/court-presentation";

/**
 * The court badge is presentation, and its registry lives on a pool the public
 * reads do not otherwise touch. A registry that cannot be read has to cost the
 * badge and nothing else.
 */

const SUPREME_COURT = {
  country: "CZE",
  court: "Nejvyšší soud",
  ecli: "ECLI:CZ:NS:2019:25.CDO.1734.2018.1",
};

test("a court is chipped and ranked from the registry", () => {
  expect(courtPresentation(courtWeightMapFromSeed(), SUPREME_COURT)).toEqual({
    courtAbbreviation: "NS",
    courtTier: "supreme",
  });
});

test("no registry means no chip, never a chip at the wrong rank", () => {
  // The abbreviation is derivable without the registry, so the tempting
  // answer is to show it at the bottom of the scale. That draws the Supreme
  // Court as a district one; the court's name is beside it either way.
  expect(courtPresentation(null, SUPREME_COURT)).toEqual({
    courtAbbreviation: null,
    courtTier: "other",
  });
});

test("a registry read that fails degrades instead of propagating", async () => {
  expect(
    await readCourtRegistry(async () => {
      throw new TypeError("root pool unreachable");
    }),
  ).toBeNull();
});

test("a registry read that stalls degrades instead of holding the read", async () => {
  expect(
    await readCourtRegistry(
      async () =>
        await new Promise(() => {
          // Never settles: the pooled connection the server reaped silently.
        }),
    ),
  ).toBeNull();
}, 10_000);

test("a registry that answers is passed through", async () => {
  const registry = courtWeightMapFromSeed();

  expect(await readCourtRegistry(async () => registry)).toBe(registry);
});
