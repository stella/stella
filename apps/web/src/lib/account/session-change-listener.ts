import type { QueryClient } from "@tanstack/react-query";

import { professionalUseOptions, sessionOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { signedInUserId } from "@/lib/session-cache-guard";

type SessionChangeListenerOptions = {
  /** Subscribes to other tabs' notes; returns the unsubscribe. */
  listen: (onSignal: () => void) => () => void;
  /** Subscribes to the page coming back from the browser's back/forward
   *  cache; returns the unsubscribe. */
  onRestore: (listener: () => void) => () => void;
  /** Whether the tab is out of view: a reload then waits until it is back. */
  isHidden: () => boolean;
  /** Subscribes to the tab coming back into view; returns the unsubscribe. */
  onVisible: (listener: () => void) => () => void;
  /** Loads the page on screen again as a new document. */
  reloadDocument: () => void;
};

/**
 * When another tab signals that who is signed in may have changed, or the
 * page comes back from the back/forward cache, this tab reads its session
 * again, past the usual freshness window, right away: the storage pruning
 * and the session cache guard act on that read even out of view. A different
 * user is taken over by the session cache guard; a user who signed out
 * elsewhere leaves this tab as a new document, once, when it is next in view.
 * Nothing here signals back, so tabs never set one another off.
 */
export const installSessionChangeListener = (
  queryClient: QueryClient,
  {
    listen,
    onRestore,
    isHidden,
    onVisible,
    reloadDocument,
  }: SessionChangeListenerOptions,
) => {
  let reloadWhenVisible = false;
  let reloading = false;

  const reload = () => {
    if (reloading) {
      return;
    }
    if (isHidden()) {
      reloadWhenVisible = true;
      return;
    }
    reloading = true;
    reloadDocument();
  };

  const readSessionAgain = async () => {
    const before = signedInUserId(
      queryClient.getQueryData(sessionOptions.queryKey),
    );
    await queryClient.query({ ...sessionOptions, staleTime: 0 });
    const after = signedInUserId(
      queryClient.getQueryData(sessionOptions.queryKey),
    );
    if (before !== undefined && after === undefined) {
      reload();
    }
    if (after !== undefined) {
      await queryClient.invalidateQueries({
        queryKey: professionalUseOptions(after).queryKey,
        refetchType: "all",
      });
    }
  };

  const readInBackground = () => {
    detached(readSessionAgain(), "session-change.read");
  };
  const stopListening = listen(readInBackground);
  const stopWatchingRestores = onRestore(readInBackground);
  const stopWatchingView = onVisible(() => {
    if (reloadWhenVisible) {
      reloadWhenVisible = false;
      reload();
    }
  });

  return () => {
    stopListening();
    stopWatchingRestores();
    stopWatchingView();
  };
};
