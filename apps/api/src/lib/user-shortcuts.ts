import { APIError } from "better-auth/api";

/**
 * Server-side structural validation for the `userShortcuts` additional field.
 *
 * The authoritative rebind guard (valid shortcut ids, collision-freedom within
 * a `ShortcutContext`) lives client-side next to the shortcut registry, which
 * the API deliberately does not import to avoid coupling the two apps. The
 * server's job here is narrower and forward-compatible: accept only a JSON
 * object mapping short string keys to short string values, cap the entry count
 * and total length, and re-serialize canonically so a malformed or oversized
 * blob can never reach the column. New shortcut ids added on the client keep
 * validating without an API change.
 */
const MAX_USER_SHORTCUTS_ENTRIES = 64;
const MAX_USER_SHORTCUTS_JSON_LENGTH = 4096;
const MAX_SHORTCUT_ID_LENGTH = 64;
const MAX_SHORTCUT_BINDING_LENGTH = 64;

const rejectUserShortcuts = (): never => {
  throw new APIError("BAD_REQUEST", { message: "Invalid keyboard shortcuts" });
};

/**
 * Normalize the incoming `userShortcuts` field for persistence.
 *
 * - `undefined` (field absent from the update) is passed through untouched.
 * - `null` or an empty object clears the override map.
 * - A valid object is canonically re-serialized (stable key order).
 * - Anything else throws a `BAD_REQUEST`.
 */
export const normalizeUserShortcutsField = (
  value: unknown,
): string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return rejectUserShortcuts();
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > MAX_USER_SHORTCUTS_JSON_LENGTH) {
    return rejectUserShortcuts();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return rejectUserShortcuts();
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return rejectUserShortcuts();
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    return null;
  }
  if (entries.length > MAX_USER_SHORTCUTS_ENTRIES) {
    return rejectUserShortcuts();
  }

  // Sort by raw codepoint, not locale: these are opaque shortcut ids, and a
  // stable byte order keeps the serialized column canonical without pulling in
  // locale-aware collation.
  const byId = ([a]: [string, unknown], [b]: [string, unknown]): number => {
    if (a < b) {
      return -1;
    }
    return a > b ? 1 : 0;
  };

  const normalized: Record<string, string> = {};
  for (const [id, binding] of entries.toSorted(byId)) {
    if (id.length === 0 || id.length > MAX_SHORTCUT_ID_LENGTH) {
      return rejectUserShortcuts();
    }
    if (typeof binding !== "string" || binding.length === 0) {
      return rejectUserShortcuts();
    }
    if (binding.length > MAX_SHORTCUT_BINDING_LENGTH) {
      return rejectUserShortcuts();
    }
    normalized[id] = binding;
  }

  return JSON.stringify(normalized);
};
