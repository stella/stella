import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";

import { CancelledError } from "@tanstack/react-query";
import { StartClient } from "@tanstack/react-start/client";

import { RenderStormCanary } from "@/components/render-storm-canary";
import { initializeI18n } from "@/i18n/i18n-store";
import { detached } from "@/lib/detached";
import { installPreloadErrorRecovery } from "@/lib/preload-error-recovery";
import { isPublicSsrPath } from "@/lib/public-ssr-paths";

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
          // eslint-disable-next-line no-console -- top-level hydration error boundary, no logger in scope
          console.error(error);
        },
      },
    );
  });
};

// Recover from failed route-chunk imports before they blank the screen.
installPreloadErrorRecovery();

if (isPublicSsrPath(window.location.pathname)) {
  // The server rendered these paths with the bundled English (the only
  // locale it has). Hydration must run against identical i18n state, so
  // the persisted locale loads only after the first paint and then
  // swaps in place — both the IntlProvider subtree and the module-level
  // translator behind pageTitle()/HeadContent stay English until then.
  hydrate();
  requestAnimationFrame(() => {
    setTimeout(() => {
      detached(initializeI18n(), "client.i18n");
    }, 0);
  });
} else {
  detached(initializeI18n().finally(hydrate), "client.i18n");
}
