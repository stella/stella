import type { StoredSession } from "@/connection/session";
import type { DraftScope } from "@/native/dictation-recorder";

export type DictationIdentity =
  | { readonly kind: "signed-in"; readonly scope: DraftScope }
  | { readonly kind: "signed-out" };

type SessionIdentity = Pick<StoredSession, "serverUrl" | "userId">;

export const dictationIdentity = (
  session: SessionIdentity | null,
): DictationIdentity => {
  if (session === null) {
    return { kind: "signed-out" };
  }
  return {
    kind: "signed-in",
    scope: {
      serverOrigin: new URL(session.serverUrl).origin,
      userId: session.userId,
    },
  };
};
