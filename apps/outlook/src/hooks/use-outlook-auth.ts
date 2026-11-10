import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Result } from "better-result";

import type { SignInError, SignInFailure } from "@/lib/oauth/errors";
import { outlookAuth, type PreparedSignIn } from "@/lib/outlook-auth";

export type SignInState =
  | { type: "idle" }
  | { type: "signing-in" }
  | { failure: SignInFailure; type: "error" };

type PreparedAttempt = Promise<Result<PreparedSignIn, SignInError>>;

/**
 * Sign-in status and actions for the task pane. The next sign-in attempt is
 * prepared (discovery, client id, PKCE) while the sign-in screen shows, so a
 * click opens the dialog straight away, inside the user gesture.
 */
export const useOutlookAuth = () => {
  const auth = outlookAuth();
  const status = useSyncExternalStore(auth.subscribe, auth.getStatus);
  const [signInState, setSignInState] = useState<SignInState>({
    type: "idle",
  });
  const preparing = useRef<PreparedAttempt | null>(null);
  const prepared = useRef<PreparedSignIn | null>(null);

  const startPreparing = async (): PreparedAttempt => {
    prepared.current = null;
    const result = await auth.prepareSignIn();
    if (Result.isOk(result)) {
      prepared.current = result.value;
    }
    return result;
  };

  useEffect(() => {
    if (status === "signed-out" && preparing.current === null) {
      preparing.current = startPreparing();
    }
  });

  const runSignIn = async (): Promise<Result<void, SignInError>> => {
    const ready = prepared.current;
    const pending = preparing.current;
    // Every attempt's state and verifier are single-use.
    prepared.current = null;
    preparing.current = null;
    if (ready) {
      return await auth.signIn(ready, { promptBeforeOpen: false });
    }
    const next = await (pending ?? startPreparing());
    if (Result.isError(next)) {
      return Result.err(next.error);
    }
    // Preparation outlived the click, so Outlook asks before opening.
    return await auth.signIn(next.value, { promptBeforeOpen: true });
  };

  const signIn = () => {
    setSignInState({ type: "signing-in" });
    runSignIn()
      .then((result) => {
        setSignInState(
          Result.isError(result)
            ? { failure: result.error.failure, type: "error" }
            : { type: "idle" },
        );
        return result;
      })
      .catch(() => {
        setSignInState({ failure: "unavailable", type: "error" });
      });
  };

  const signOut = () => {
    auth.signOut().catch(() => {
      // The grant is already forgotten locally; an unreachable revocation
      // endpoint leaves it to expire on its own.
    });
  };

  return { signIn, signInState, signOut, status };
};
