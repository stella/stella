import { describe, expect, test } from "bun:test";

import {
  resolveCzechLaw,
  resolveLawCitation,
} from "@/api/handlers/legal-resolve/law";
import { createSafeId } from "@/api/lib/branded-types";

const documentId = createSafeId<"legislationDocument">();
const dependencies = (anchor = "par_12a") => ({
  resolveExpression: async () => ({
    type: "expression" as const,
    id: documentId,
  }),
  readDocument: async () => ({ eli: "eli", title: "Act" }),
  readPreview: async (input: { anchor: string }) => {
    expect(input.anchor).toBe(anchor);
    return { blocks: [], appUrl: "/law/example" };
  },
});

describe("law citation resolution", () => {
  test("resolves current and outdated versions", async () => {
    const input = {
      collection: "sb",
      year: "2024",
      number: "1",
      section: "12 a",
    };
    expect(await resolveCzechLaw(input, dependencies())).toMatchObject({
      status: "resolved",
      document: { metadata: { inForce: true, versionStatus: "current" } },
    });
    expect(
      await resolveCzechLaw({ ...input, asOf: "2023-01-01" }, dependencies()),
    ).toMatchObject({
      status: "resolved",
      document: { metadata: { inForce: false, versionStatus: "outdated" } },
    });
  });

  test("normalizes section spaces and letter suffixes", async () => {
    await resolveCzechLaw(
      { collection: "sb", year: "2024", number: "1", section: " 12 A " },
      dependencies(),
    );
  });

  test("distinguishes unknown sections and documents", async () => {
    const input = {
      collection: "sb",
      year: "2024",
      number: "1",
      section: "12",
    };
    expect(
      await resolveCzechLaw(input, {
        ...dependencies("par_12"),
        readPreview: async () => ({ status: 404, message: "missing" }),
      }),
    ).toEqual({ status: "not_found", reason: "unknown_section" });
    expect(
      await resolveCzechLaw(input, {
        ...dependencies("par_12"),
        resolveExpression: async () => ({ type: "unknown-work" as const }),
      }),
    ).toEqual({ status: "not_found", reason: "unknown_document" });
  });

  test("returns country unavailable outside Czechia", async () => {
    expect(await resolveLawCitation("DEU", { citation: "unknown" })).toEqual({
      status: "country_unavailable",
    });
  });
});
