import { expect, test } from "bun:test";

import type { RegistryClientOptions } from "@stll/business-registries/shared";
import type { RegistryRequestObservation } from "@stll/business-registries/shared/request-observer";

import type { RegistryHandler } from "@/api/lib/business-registries/dispatch";
import type { RunEntityCheckSharedProps } from "@/api/lib/business-registries/entity-checks";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";

type ObservationIsRequired<T> = T extends (...args: infer Args) => unknown
  ? Args extends [...unknown[], RegistryRequestObservation]
    ? true
    : Args extends [...unknown[], { observer: RegistryRequestObservation }]
      ? true
      : false
  : T extends { observer: RegistryRequestObservation }
    ? true
    : false;

const corpusContracts = {
  createIndex: true,
  deleteIndex: true,
  indexExists: true,
  attestIndexConfig: true,
  ingestBatch: true,
  ingestCommittedBatch: true,
  ingestQueuedBatch: true,
  search: true,
  scoredSearch: true,
  aggregate: true,
  deleteByQuery: true,
  readDeleteSettlements: true,
} as const satisfies {
  [Key in keyof CorpusIndexClient]: ObservationIsRequired<
    CorpusIndexClient[Key]
  >;
};

const registryContracts = {
  client: true,
  lookup: true,
  search: true,
  check: true,
} as const satisfies {
  client: ObservationIsRequired<RegistryClientOptions>;
  lookup: ObservationIsRequired<RegistryHandler["lookup"]>;
  search: ObservationIsRequired<NonNullable<RegistryHandler["search"]>>;
  check: ObservationIsRequired<RunEntityCheckSharedProps>;
};

test("every outbound entry point requires an explicit observation choice", () => {
  expect(Object.values(corpusContracts).every(Boolean)).toBe(true);
  expect(Object.values(registryContracts).every(Boolean)).toBe(true);
});
