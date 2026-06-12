import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";

import { CancelledError } from "@tanstack/react-query";
import { StartClient } from "@tanstack/react-start/client";

import { initializeI18n } from "@/i18n/i18n-store";
import { isPublicSsrPath } from "@/lib/public-ssr-paths";

const hydrate = () => {
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <StartClient />
      </StrictMode>,
      {
        onCaughtError: (error) => {
          // CancelledError is benign: React Query throws it during route
          // transitions when a suspended query unmounts.
          if (error instanceof CancelledError) {
            return;
          }
          // eslint-disable-next-line no-console
          console.error(error);
        },
      },
    );
  });
};

if (isPublicSsrPath(window.location.pathname)) {
  // The server rendered these paths with the bundled English (the only
  // locale it has). Hydration must run against identical i18n state, so
  // the persisted locale loads only after the first paint and then
  // swaps in place — both the IntlProvider subtree and the module-level
  // translator behind pageTitle()/HeadContent stay English until then.
  hydrate();
  requestAnimationFrame(() => {
    setTimeout(() => {
      void initializeI18n();
    }, 0);
  });
} else {
  void initializeI18n().finally(hydrate);
}
