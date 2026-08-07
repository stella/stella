/**
 * Resolve the label to show for a user.
 *
 * `user.name` is only ever populated at signup. Email-OTP signup and some
 * social providers leave it blank, and the column's `notNull` constraint
 * still admits the empty string, so a stored name of `""` reaches the UI.
 * Rendering it raw produces an identity with no initials and no label —
 * a visually empty row.
 *
 * Callers pass the email as the fallback so an account with no name still
 * shows something addressable. Returns `null` when neither is usable; the
 * caller supplies a translated placeholder.
 */
export const getDisplayName = (
  name: string | null | undefined,
  email?: string | null,
): string | null => name?.trim() || email?.trim() || null;
