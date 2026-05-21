/**
 * Extract up to two uppercase initials from a display name.
 *
 * Behaviour:
 * - Multi-word: first letter of each of the first two words.
 *   "Eva Schmidt" → "ES", "Jan van Houten" → "JV"
 * - Single-word (Latin): first two characters.
 *   "John" → "JO"
 * - CJK / no-space scripts: first two characters.
 *   "王小明" → "王小"
 * - Null / empty: "?"
 */
export const getInitials = (name: string | null): string => {
  if (!name) {
    return "?";
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "?";
  }

  const parts = trimmed.split(/\s+/u);
  if (parts.length >= 2) {
    const a = parts.at(0) ?? "";
    const b = parts.at(1) ?? "";
    return `${a.at(0) ?? ""}${b.at(0) ?? ""}`.toUpperCase();
  }

  // Single token: take first two characters (works for
  // Latin single-word names and CJK scripts alike).
  return trimmed.slice(0, 2).toUpperCase();
};
