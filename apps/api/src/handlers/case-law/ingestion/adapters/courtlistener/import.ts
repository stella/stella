import { IMPORT_SOURCE_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";

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
  mapRecord: mapCourtListenerRecord,
  reparseStoredRaw,
  sourceFields: COURTLISTENER_SOURCE_FIELD_INVENTORY,
  sourceSurfaces: COURTLISTENER_SOURCE_SURFACES,
} as const;
