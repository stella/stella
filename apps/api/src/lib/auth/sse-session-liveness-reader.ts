import { rootDb } from "@/api/db/root";
import { readLiveSseSessions } from "@/api/lib/auth/sse-session-liveness";
import type { SseSessionLivenessReader } from "@/api/lib/sse";

// Session revocation is a credential check, independent of matter access.
export const readCurrentLiveSseSessions: SseSessionLivenessReader = async (
  sessions,
) => await readLiveSseSessions(rootDb, sessions);
