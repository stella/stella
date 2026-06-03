import type { QueryClient } from "@tanstack/react-query";

import { ensureCriticalQueryData } from "@/lib/react-query";
import { sessionOptions } from "@/routes/-queries";

export const loadAuthContext = async (queryClient: QueryClient) => {
  const sessionData = await ensureCriticalQueryData(
    queryClient,
    sessionOptions,
  ).catch(() => null);

  return {
    session: sessionData?.session ?? null,
    user: sessionData?.user ?? null,
  };
};
