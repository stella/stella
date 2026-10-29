import { useMemo } from "react";

import { useSession } from "@/connection/session-provider";
import { dictationIdentity } from "@/features/dictation/identity-source";
import {
  canRecordDictation,
  createDictationRecorder,
} from "@/native/dictation-recorder";

export const useDictationIdentity = () => {
  const { state } = useSession();
  return dictationIdentity(
    state.status === "signed-in" ? state.source.session() : null,
  );
};

export const useDictationRecorder = () => {
  const identity = useDictationIdentity();
  const serverOrigin =
    identity.kind === "signed-in" ? identity.scope.serverOrigin : null;
  const userId = identity.kind === "signed-in" ? identity.scope.userId : null;
  // Consumers keep recovery notices and recorder state by service identity.
  return useMemo(
    () =>
      serverOrigin === null || userId === null || !canRecordDictation()
        ? null
        : createDictationRecorder({ serverOrigin, userId }),
    [serverOrigin, userId],
  );
};
