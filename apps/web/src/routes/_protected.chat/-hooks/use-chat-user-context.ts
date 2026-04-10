import { useMemo } from "react";

import { useRouteContext } from "@tanstack/react-router";
import { useLocale } from "use-intl";

export type ChatUserContext = {
  userName: string;
  locale: string;
  timezone: string;
};

const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Collect user context for the chat transport. */
export const useChatUserContext = (): ChatUserContext => {
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
