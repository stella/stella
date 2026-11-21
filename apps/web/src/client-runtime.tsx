import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

import { StartClient } from "@tanstack/react-start/client";

import { RenderStormCanary } from "@/components/render-storm-canary";
import { getAnalytics } from "@/lib/analytics/provider";
import { createRootCaughtErrorHandler } from "@/lib/analytics/root-caught-error";
import { detached } from "@/lib/detached";

/**
 * React's production message for a recovered render (a hydration mismatch,
 * for one) names no component; its component stack does.
 */
const withComponentStack = (error: unknown, componentStack?: string) =>
  componentStack && error instanceof Error
    ? new Error(`${error.message}${componentStack}`, { cause: error })
    : error;

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
        onCaughtError: createRootCaughtErrorHandler(getAnalytics),
        onRecoverableError: (error, errorInfo) => {
          reportError(withComponentStack(error, errorInfo.componentStack));
        },
      },
    );
  });
};

// Router hydration restores the server's locale and presentation preferences
// before React renders the document.
detached(Promise.resolve().then(hydrate), "client.hydration");
