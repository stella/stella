import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { FieldDescription } from "@stll/ui/field";

import { authClient } from "@/lib/auth-client";

/**
 * The method name better-auth left in this browser's cookie. Reading cookies
 * can throw where storage is blocked (sandboxed frames); then nothing is
 * emphasised.
 */
export const readLastUsedLoginMethod = (): string | null =>
  Result.try(() => authClient.getLastUsedLoginMethod()).unwrapOr(null);

/** Where the "Last used" badge sits: over the top end corner of its control. */
export const LAST_USED_BADGE_POSITION_CLASS_NAME =
  "pointer-events-none absolute end-3 -top-2.5";

/** The badge itself: a small pill. */
export const LAST_USED_BADGE_PILL_CLASS_NAME =
  "border-border bg-background text-foreground text-3xs rounded-full border px-2 py-0.5 font-medium shadow-xs";

/**
 * The "Last used" badge for a method typed into a form: pinned to the corner
 * of its email field (the field must be `relative`) and announced as the
 * field's description, which the field links to its input.
 */
export const LastUsedFieldBadge = () => {
  const t = useTranslations();
  return (
    <FieldDescription className={LAST_USED_BADGE_POSITION_CLASS_NAME}>
      <span className={LAST_USED_BADGE_PILL_CLASS_NAME}>
        {t("auth.lastUsed")}
      </span>
    </FieldDescription>
  );
};
