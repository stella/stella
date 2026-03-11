import { useMemo } from "react";

import { useRouteContext } from "@tanstack/react-router";
import { useLocale } from "use-intl";

import type { UserContext } from "@/lib/ai-sdk/rivet-transport";

const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Collect user context for the chat transport. */
export const useChatUserContext = (): UserContext => {
  const user = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user,
  });
  const locale = useLocale();
  return useMemo(
    () => ({
      userName: user.name ?? "",
      locale,
      timezone: BROWSER_TIMEZONE,
    }),
    [user.name, locale],
  );
};
