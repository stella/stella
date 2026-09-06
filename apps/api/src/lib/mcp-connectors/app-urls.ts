/**
 * Links back into the web app.
 *
 * The deployment's frontend origin lives in one place so a link an API
 * response hands a person or an agent points at the same app as every other
 * one, on a self-hosted deployment as much as on the hosted one. It sits next
 * to the connector/native-tool catalogue metadata because the catalogue entry
 * page is what these links mostly name, and because the flat
 * `apps/api/src/lib` bucket only shrinks.
 */

import { env } from "@/api/env";

/** The deployment's frontend origin, without a trailing slash. */
export const getAppBaseUrl = () => env.FRONTEND_URL.replace(/\/$/u, "");

/**
 * The catalogue entry's page under Knowledge → Tools, opened on its detail
 * panel. `slug` is a catalogue slug (`krs`, `ares`, ...); the Tools route
 * reads it from `?slug=` and selects that entry.
 */
export const buildCatalogueEntryUrl = (slug: string): string =>
  `${getAppBaseUrl()}/knowledge/tools?slug=${encodeURIComponent(slug)}`;
