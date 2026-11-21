import { expect, spyOn, test } from "bun:test";

import { US_COURTS } from "@stll/api-contract/us-courts";

import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import {
  courtPresentation,
  decisionCourtAbbreviation,
  readCourtRegistry,
} from "@/api/lib/case-law/court-presentation";
import { logger } from "@/api/lib/observability/logger";

/**
 * The court badge is presentation, and its registry lives on a pool the public
 * reads do not otherwise touch. A registry that cannot be read has to cost the
 * badge and nothing else.
 */

const SUPREME_COURT = {
  country: "CZE",
  court: "Nejvyšší soud",
  courtId: null,
  ecli: "ECLI:CZ:NS:2019:25.CDO.1734.2018.1",
};

test("every directory court supplies its citation code independently of DB registry availability", () => {
  const registry = courtWeightMapFromSeed();
  for (const directoryCourt of US_COURTS) {
    const subject = {
      country: "USA",
      court: directoryCourt.canonicalName,
      courtId: directoryCourt.id,
    };
    expect(decisionCourtAbbreviation(subject), directoryCourt.id).toBe(
      directoryCourt.shortCode,
    );
    expect(courtPresentation(null, subject), directoryCourt.id).toEqual(
      courtPresentation(registry, subject),
    );
    expect(
      courtPresentation(null, subject).courtAbbreviation,
      directoryCourt.id,
    ).toBe(directoryCourt.shortCode);
  }
});

test("a court is chipped and ranked from the registry", () => {
  expect(courtPresentation(courtWeightMapFromSeed(), SUPREME_COURT)).toEqual({
    courtAbbreviation: "NS",
    courtTier: "supreme",
  });
});

test("a page with a corrupt directory court draws its peers and no chip for that row", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    const scotus = "Supreme Court of the United States";
    const page = [
      { country: "USA", court: scotus, courtId: "scotus", ecli: null },
      // A stored id the directory does not resolve, under a name the
      // registry still ranks supreme.
      { country: "USA", court: scotus, courtId: "bad-id", ecli: null },
      {
        country: "USA",
        court: "Court of Appeals for the First Circuit",
        courtId: "ca1",
        ecli: null,
      },
      SUPREME_COURT,
    ].map(
      (decision) =>
        courtPresentation(courtWeightMapFromSeed(), decision).courtTier,
    );
    expect(page).toEqual(["supreme", "other", "regional", "supreme"]);
    expect(
      courtPresentation(courtWeightMapFromSeed(), {
        country: "USA",
        court: scotus,
        courtId: "bad-id",
        ecli: null,
      }).courtAbbreviation,
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "case_law.court_rank.invalid_directory_identity",
      {
        country: "USA",
        lookup: "court_id",
        "court.identity": "bad-id",
        effect: "unranked",
      },
    );
  } finally {
    warn.mockRestore();
  }
});

test("code-only readers report an invalid directory identity", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    for (const courtId of [null, "bad-id"]) {
      expect(
        decisionCourtAbbreviation({
          country: "USA",
          court: "Unknown",
          courtId,
        }),
      ).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        "case_law.court_rank.invalid_directory_identity",
        {
          country: "USA",
          lookup: "court_id",
          "court.identity": courtId ?? "none",
          effect: "unranked",
        },
      );
    }
  } finally {
    warn.mockRestore();
  }
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
