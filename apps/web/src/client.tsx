import { StrictMode, startTransition, useLayoutEffect } from "react";
import { hydrateRoot } from "react-dom/client";

import { CancelledError } from "@tanstack/react-query";
import { StartClient } from "@tanstack/react-start/client";

import { RenderStormCanary } from "@/components/render-storm-canary";
import { detached } from "@/lib/detached";
import { installPreloadErrorRecovery } from "@/lib/preload-error-recovery";

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
          // oxlint-disable-next-line no-console -- top-level hydration error boundary, no logger in scope
          console.error(error);
        },
      },
    );
  });
  await hydrationCommit.promise;
};

// Recover from failed route-chunk imports before they blank the screen.
installPreloadErrorRecovery();

// Router hydration restores the server's exact catalogue and preferences
// before React renders the document.
detached(hydrate(), "client.hydration");
