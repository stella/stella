import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

import { CancelledError } from "@tanstack/react-query";
import { StartClient } from "@tanstack/react-start/client";

import { RenderStormCanary } from "@/components/render-storm-canary";
import { getAnalytics } from "@/lib/analytics/provider";
import { reportErrorOnce } from "@/lib/analytics/reported-error";
import { detached } from "@/lib/detached";

const hydrate = () => {
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
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
          reportErrorOnce(error, (caughtError) => {
            getAnalytics().captureError(caughtError, {
              fingerprintKey: "hydrate:onCaughtError",
              scope: { type: "handler", handlerId: "hydrate:onCaughtError" },
            });
          });
        },
      },
    );
  });
};

// Router hydration restores the server's locale and presentation preferences
// before React renders the document.
detached(Promise.resolve().then(hydrate), "client.hydration");
