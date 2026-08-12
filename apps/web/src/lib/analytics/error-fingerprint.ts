import { telemetryErrorType } from "@/lib/analytics/error-diagnostics";

const FIRST_PARTY_ASSET_FRAME =
  /\/assets\/([A-Za-z0-9._-]{1,160}\.(?:js|mjs)):(\d{1,7}):(\d{1,7})/u;

const stableHash = (value: string): string => {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 4_294_967_296;
  }
  return hash.toString(16).padStart(8, "0").toUpperCase();
};

/** Only an error type and compiled first-party asset position influence this hash. */
export const fingerprintTelemetryError = (error: unknown): string => {
  const stack = error instanceof Error ? error.stack : undefined;
  const frame = stack?.slice(0, 20_000).match(FIRST_PARTY_ASSET_FRAME);
  const safeFrame = frame
    ? `${frame[1]}:${frame[2]}:${frame[3]}`
    : "no-first-party-frame";
  return `ERRFP-${stableHash(`${telemetryErrorType(error)}|${safeFrame}`)}`;
};
