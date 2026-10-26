import { startTransition, StrictMode, useLayoutEffect } from "react";
import { hydrateRoot } from "react-dom/client";

import { CancelledError } from "@tanstack/react-query";
import { getRouterInstance } from "@tanstack/react-start";
import { StartClient } from "@tanstack/react-start/client";
import { Result } from "better-result";

import { RenderStormCanary } from "@/components/render-storm-canary";
import { loadClientDocumentPresentation } from "@/i18n/document-presentation";
import { getTranslator } from "@/i18n/translator";
import { getAnalytics } from "@/lib/analytics/provider";
import { reportErrorOnce } from "@/lib/analytics/reported-error";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";

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
  await hydrationCommit.promise;
  const router = await getRouterInstance();
  const presentation = await Result.tryPromise(
    async () =>
      await loadClientDocumentPresentation(router.options.context.queryClient),
  );
  if (presentation.isErr()) {
    notifyUserError(presentation.error, getTranslator()("errors.actionFailed"));
  }
};

// Router hydration restores the server's locale and presentation preferences
// before React renders the document.
detached(hydrate(), "client.hydration");
