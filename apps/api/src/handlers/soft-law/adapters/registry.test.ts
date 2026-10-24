import { expect, expectTypeOf, test } from "bun:test";

import { GUIDANCE_KINDS } from "@stll/legal-ast/document-kind";

import { validateSoftLawAuthorityMetadata } from "@/api/lib/legal-search/soft-law-authority-policy";
import type { SoftLawMetadata } from "@/api/lib/legal-search/soft-law-types";

import {
  type RegisteredSoftLawAuthority,
  SOFT_LAW_ADMISSIONS,
} from "./registry";

test("unregistered authorities cannot enter the sync contract", () => {
  expectTypeOf<"eu-edps">().not.toExtend<RegisteredSoftLawAuthority>();
  expectTypeOf<"de-bfdi">().not.toExtend<RegisteredSoftLawAuthority>();
});

test("every registered adapter belongs to its authority; pending kinds are refused", () => {
  for (const [authority, disposition] of Object.entries(SOFT_LAW_ADMISSIONS)) {
    if (disposition.state === "registered") {
      expect(authority).toBe(disposition.adapter.authority);
      expect(disposition.descriptor.allowsRedistribution).toBe(false);
      expect(disposition.descriptor.allowsDerivedAi).toBe(false);
      continue;
    }
    expect(disposition).not.toHaveProperty("adapter");
  }
  for (const authority of ["eu-edps", "de-bfdi"] as const) {
    for (const kind of GUIDANCE_KINDS) {
      const metadata = {
        title: "Guidance",
        kind,
        sourceKind: "Guidance",
        sourceDocumentId: "record/123",
        statedReference: { state: "not_stated" },
        issuedOn: { state: "not_stated" },
        expression: {
          type: "identified",
          language: "de",
          revision: { state: "not_stated" },
        },
        stage: { state: "not_stated" },
        relations: [],
        validity: { state: "not_stated", basis: "source_stated" },
      } as const satisfies SoftLawMetadata;
      expect(
        validateSoftLawAuthorityMetadata(authority, metadata).isErr(),
      ).toBe(true);
    }
  }
});
