import {
  buildCliClientMetadataDocument,
  CLI_CLIENT_METADATA_PATH,
  CLI_LOOPBACK_CLIENT_METADATA,
} from "@stll/cli/client-metadata-document";
import { normalizeUnicode } from "@stll/text-normalize";

export const CLI_CLIENT_DISPLAY_NAME = buildCliClientMetadataDocument(
  CLI_CLIENT_METADATA_PATH,
).client_name;

/** A released CLI registration shape, never evidence of publisher identity. */
const isCliLoopbackRegistration = (body: Record<string, unknown>): boolean =>
  Object.entries(CLI_LOOPBACK_CLIENT_METADATA).every(
    ([field, value]) => JSON.stringify(body[field]) === JSON.stringify(value),
  );

// A deliberately bounded first-party-name guard, not a general Unicode skeleton.
const CLIENT_NAME_LOOKALIKES = new Map([
  ["а", "a"],
  ["α", "a"],
  ["е", "e"],
  ["ε", "e"],
  ["о", "o"],
  ["ο", "o"],
  ["р", "p"],
  ["ρ", "p"],
  ["с", "c"],
  ["ϲ", "c"],
  ["х", "x"],
  ["χ", "x"],
  ["ѕ", "s"],
  ["і", "i"],
  ["ι", "i"],
  ["ј", "j"],
  ["у", "y"],
  ["υ", "y"],
  ["0", "o"],
  ["1", "l"],
  ["|", "l"],
]);

const reservedClientNameKey = (name: string): string =>
  [...normalizeUnicode(name, "NFKC").replace(/I/gu, "l").toLowerCase()]
    .map((character) => CLIENT_NAME_LOOKALIKES.get(character) ?? character)
    .join("")
    .replace(/[\s\p{P}\p{Cf}]/gu, "");

const RESERVED_STELLA_CLIENT_NAMES = new Set(
  ["stella", CLI_CLIENT_DISPLAY_NAME, "stella-cli"].map(reservedClientNameKey),
);

/** First-party names cannot be claimed by unrelated dynamic registrations. */
export const isReservedStellaClientName = (name: string): boolean =>
  RESERVED_STELLA_CLIENT_NAMES.has(reservedClientNameKey(name));

export const mayRegisterClientName = (
  body: Record<string, unknown>,
): boolean => {
  const name = body["client_name"];
  return (
    typeof name !== "string" ||
    !isReservedStellaClientName(name) ||
    (name === CLI_CLIENT_DISPLAY_NAME && isCliLoopbackRegistration(body))
  );
};

const STORED_METADATA_COLUMNS = {
  application_type: "application_type",
  grant_types: "grant_types",
  redirect_uris: "redirect_uris",
  response_types: "response_types",
  token_endpoint_auth_method: "token_endpoint_auth_method",
} as const satisfies Record<keyof typeof CLI_LOOPBACK_CLIENT_METADATA, string>;

/** The stored shape and registration policy are derived from the same metadata. */
export const CLI_LOOPBACK_REGISTRATION_PREDICATE_SQL = Object.entries(
  STORED_METADATA_COLUMNS,
)
  .map(([field, column]) => `'${field}', ${column}`)
  .join(", ");

export const CLI_LOOPBACK_REGISTRATION_METADATA_JSON = JSON.stringify(
  CLI_LOOPBACK_CLIENT_METADATA,
);
