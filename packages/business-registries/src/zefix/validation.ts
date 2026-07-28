import {
  compact as compactSwissUid,
  format as formatSwissUid,
  validate as validateSwissUid,
} from "@stll/stdnum/ch/uid";

import { type CanonicalId, unsafeBrand } from "../shared/canonical-id.js";

export type SwissUid = CanonicalId<"CH-UID">;

const OPTIONAL_PREFIX_UID = /^(?:CHE[-.\s]?)?(?<digits>(?:\d[-.\s]?){9})$/iu;

const withSwissPrefix = (input: string): string => {
  const trimmed = input.trim().toUpperCase();
  const match = OPTIONAL_PREFIX_UID.exec(trimmed);
  if (!match?.groups) {
    return trimmed;
  }
  const digits = match.groups["digits"]?.replaceAll(/[-.\s]/gu, "") ?? "";
  return `CHE${digits}`;
};

const withoutSwissPrefix = (compact: string): string =>
  compact.startsWith("CHE") ? compact.slice(3) : compact;

export const normalizeUid = (input: string): string =>
  withoutSwissPrefix(compactSwissUid(withSwissPrefix(input)));

export const parseUid = (input: string): SwissUid | null => {
  const prefixed = withSwissPrefix(input);
  if (!validateSwissUid(prefixed).valid) {
    return null;
  }
  return unsafeBrand<"CH-UID">(withoutSwissPrefix(compactSwissUid(prefixed)));
};

export const validateUid = (input: string): boolean => parseUid(input) !== null;

export const formatUid = (input: string): string => {
  const prefixed = withSwissPrefix(input);
  if (!validateSwissUid(prefixed).valid) {
    return input.trim();
  }
  return formatSwissUid(prefixed);
};
