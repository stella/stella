import * as v from "valibot";

import { CONTACT_TYPES } from "@stll/api-contract";
import type { ContactType } from "@stll/api-contract";

const MATTER_NAME_MAX_CHARS = 256;
const CLIENT_NAME_MAX_CHARS = 512;

export const matterSuggestionAISchema = v.strictObject({
  name: v.string(),
  clientName: v.nullable(v.string()),
  clientType: v.nullable(v.picklist(CONTACT_TYPES)),
});

export type MatterSuggestion = {
  name: string | null;
  client: { displayName: string; type: ContactType } | null;
};

const clean = (value: string | null, maxChars: number) => {
  const trimmed = value?.replaceAll(/\s+/gu, " ").trim() ?? "";
  return trimmed === "" ? null : trimmed.slice(0, maxChars);
};

export const normalizeMatterSuggestion = (
  raw: v.InferOutput<typeof matterSuggestionAISchema> | null,
): MatterSuggestion | null => {
  if (raw === null) {
    return null;
  }
  const displayName = clean(raw.clientName, CLIENT_NAME_MAX_CHARS);
  return {
    name: clean(raw.name, MATTER_NAME_MAX_CHARS),
    client:
      displayName === null
        ? null
        : { displayName, type: raw.clientType ?? "person" },
  };
};
