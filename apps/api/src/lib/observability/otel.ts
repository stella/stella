/**
 * Intentionally no external log exporter.
 *
 * Stella's PostHog integration is limited to explicit, allowlisted telemetry
 * from the analytics adapter. Request logs, info logs, and warning logs must
 * not be sent upstream as a side effect of setting PostHog env vars.
 */
export const isExternalLogExportEnabled = false;
