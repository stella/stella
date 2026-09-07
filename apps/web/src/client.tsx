import { StrictMode, startTransition, useLayoutEffect } from "react";
import { hydrateRoot } from "react-dom/client";

import { CancelledError } from "@tanstack/react-query";
import { StartClient } from "@tanstack/react-start/client";

import { bootHydratedClient } from "@stll/ssr-kit/hydration";

import { RenderStormCanary } from "@/components/render-storm-canary";
import { initializeI18n } from "@/i18n/i18n-store";
import { detached } from "@/lib/detached";
import { installPreloadErrorRecovery } from "@/lib/preload-error-recovery";
import { isPublicSsrPath } from "@/lib/public-ssr-paths";

type HydrationCommitSignalProps = {
  onCommit: () => void;
};

const HydrationCommitSignal = ({ onCommit }: HydrationCommitSignalProps) => {
  useLayoutEffect(() => {
    onCommit();
  }, [onCommit]);
  return null;
};

const hydrate = async () => {
  const hydrationCommit = Promise.withResolvers<undefined>();
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <HydrationCommitSignal
          onCommit={() => hydrationCommit.resolve(undefined)}
        />
        <RenderStormCanary>
          <StartClient />
        </RenderStormCanary>
      </StrictMode>,
      {
        onCaughtError: (error) => {
          // CancelledError is benign: React Query throws it during route
          // transitions when a suspended query unmounts.
          if (error instanceof CancelledError) {
            return;
          }
          // eslint-disable-next-line no-console -- top-level hydration error boundary, no logger in scope
          console.error(error);
        },
      },
    );
  });
  await hydrationCommit.promise;
};

// Recover from failed route-chunk imports before they blank the screen.
installPreloadErrorRecovery();

// The server renders public paths with bundled English. They hydrate against
// that same state before persisted browser state loads after the hydration
// commit.
// Client-only paths resolve browser state before their first render.
detached(
  bootHydratedClient({
    type: isPublicSsrPath(window.location.pathname)
      ? "server-rendered"
      : "client-rendered",
    hydrate,
    initializeClientState: initializeI18n,
  }),
  "client.i18n",
);
