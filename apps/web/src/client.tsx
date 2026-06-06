import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";

import { CancelledError } from "@tanstack/react-query";
import { StartClient } from "@tanstack/react-start/client";

import { initializeI18n } from "@/i18n/i18n-store";

void initializeI18n().finally(() => {
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
});
