import { createContext } from "react";

import type { AccessTokenSource } from "@/connection/session";

/**
 * The thread on screen and the session that reads it, for a coding agent's
 * step to read what it produced: stella stores it with the thread.
 */
export const ThreadSteps = createContext<
  | {
      readonly source: AccessTokenSource;
      readonly threadId: string;
    }
  | undefined
>(undefined);
