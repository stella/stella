import { useId } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { authClient } from "@/lib/auth-client";

/**
 * The method name better-auth left in this browser's cookie. Reading cookies
 * can throw where storage is blocked (sandboxed frames); then nothing is
 * emphasised.
 */
export const readLastUsedLoginMethod = (): string | null => {
  try {
    return authClient.getLastUsedLoginMethod();
  } catch {
    return null;
  }
};

/**
 * Wraps one sign-in action and, when it is the last-used method, pins a
 * "Last used" badge to its corner and links it as the action's description.
 */
export const LastUsedSignInFrame = ({
  lastUsed,
  children,
}: {
  lastUsed: boolean;
  children: (describedBy: string | undefined) => ReactNode;
}) => {
  const t = useTranslations();
  const badgeId = useId();
  return (
    <div className="relative">
      {children(lastUsed ? badgeId : undefined)}
      {lastUsed && (
        <span
          className="border-border bg-background text-foreground text-3xs pointer-events-none absolute end-3 -top-2.5 rounded-full border px-2 py-0.5 font-medium shadow-xs"
          id={badgeId}
        >
          {t("auth.lastUsed")}
        </span>
      )}
    </div>
  );
};
