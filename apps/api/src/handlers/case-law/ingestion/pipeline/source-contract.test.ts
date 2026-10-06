import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { listSourceRegistrations } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { metadataUrlSchemaForAdapter } from "@/api/handlers/case-law/ingestion/metadata-url-schemas";
import { sourceContractForAdapter } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import {
  ADAPTER_MANIFESTS,
  IMPORT_SOURCE_MANIFESTS,
  STATED_ECLI_IDENTITY,
} from "@/api/lib/legal-search/adapter-manifest";

const declaredEcliIdentity = (
  registration: ReturnType<typeof listSourceRegistrations>[number],
) => {
  switch (registration.capability) {
    case "crawl":
      return ADAPTER_MANIFESTS[registration.key].statedEcliIdentity;
    case "import":
      return IMPORT_SOURCE_MANIFESTS[registration.key].statedEcliIdentity;
    default:
      registration satisfies never;
      return panic("Unhandled source registration");
  }
};

describe("source contract", () => {
  // The pipeline decides re-keying from the contract, not the manifest: every
  // registered source must reach it with the identity its manifest declares.
  for (const registration of listSourceRegistrations()) {
    test(`${registration.key} carries its declared ECLI identity and metadata schema`, () => {
      const contract = sourceContractForAdapter(registration.key);
      expect(contract.statedEcliIdentity).toBe(
        declaredEcliIdentity(registration),
      );
      expect(contract.metadataUrlSchema).toBe(
        metadataUrlSchemaForAdapter(registration.key),
      );
    });
  }

  test("a key no manifest declares never adopts by ECLI", () => {
    expect(
      sourceContractForAdapter(`unregistered-${Bun.randomUUIDv7()}`)
        .statedEcliIdentity,
    ).toBe(STATED_ECLI_IDENTITY.NONE);
  });
});
