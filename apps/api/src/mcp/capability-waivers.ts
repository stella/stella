/**
 * Context-fidelity waiver table for the generic capability path.
 *
 * A capability whose handler reaches for an Elysia-context feature the
 * synthesized `invoke_capability` context cannot honor (response `set.status` /
 * `set.headers`, cookies, redirects, raw parsed `headers`) is listed here, keyed
 * by capability id, with a justification. `invoke_capability` refuses a waived
 * capability with a `feature_disabled` envelope pointing at the app; the export
 * script's class-guard scan (`scanContextFidelity`) fails the build if a
 * handler trips the scan without a waiver, or if a waiver is stale (its handler
 * no longer trips the scan). This is a side-effect-free constant so the export
 * script can import it without pulling in the context-synthesis graph.
 *
 * Currently empty: at seed time every catalog capability's handler returns a
 * plain payload (export handlers hand back CSV/PDF bytes or a URL string; the
 * owning route sets the content-type header, not the handler), so none trip the
 * scan. The mechanism stays live so a future handler that does cannot silently
 * become invokable through a context that would drop its response headers.
 */
export const CONTEXT_FIDELITY_WAIVERS: ReadonlyMap<string, string> = new Map<
  string,
  string
>();
