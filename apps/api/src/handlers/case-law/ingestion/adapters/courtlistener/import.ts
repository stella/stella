// parser-output-unchanged: source-exclusion-contract: Publisher schemas, raw retention and coverage checks do not change parsed decision projections.
import { IMPORT_SOURCE_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import {
  recordPublisherFieldCoverage,
  retainedPublisherParts,
} from "@/api/lib/legal-search/publisher-field-coverage";
import { logger } from "@/api/lib/observability/logger";

import {
  COURTLISTENER_SOURCE_FIELD_INVENTORY,
  COURTLISTENER_SOURCE_SURFACES,
} from "./inventory";
import {
  COURTLISTENER_IMPORT_KEY,
  COURTLISTENER_PARSER_VERSION,
  mapCourtListenerRecord,
  reparseStoredRaw,
} from "./map";

/** Import discovery and source leases belong to the caller; this capability performs no I/O. */
const manifest = IMPORT_SOURCE_MANIFESTS[COURTLISTENER_IMPORT_KEY];

export const courtListenerImport = {
  key: manifest.key,
  name: manifest.name,
  country: manifest.country,
  language: "en",
  manifest,
  parserVersion: COURTLISTENER_PARSER_VERSION,
  mapRecord: (input: unknown) =>
    mapCourtListenerRecord(input).tap((result) => {
      const parts = retainedPublisherParts({
        adapterKey: manifest.key,
        result,
      });
      recordPublisherFieldCoverage({
        adapterKey: manifest.key,
        inventory: COURTLISTENER_SOURCE_FIELD_INVENTORY,
        observedFields:
          COURTLISTENER_SOURCE_FIELD_INVENTORY.listSourceFields(parts),
        report: logger.error,
      });
    }),
  reparseStoredRaw,
  sourceFields: COURTLISTENER_SOURCE_FIELD_INVENTORY,
  sourceSurfaces: COURTLISTENER_SOURCE_SURFACES,
} as const;
