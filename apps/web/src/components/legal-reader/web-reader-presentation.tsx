import type { ReactNode } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { copyToClipboard } from "@stll/clipboard";
import { ReaderPresentationProvider } from "@stll/decision-reader/reader-adapters";
import type { ReaderPresentationAdapters } from "@stll/decision-reader/reader-adapters";

import { useWebReaderMessages } from "@/components/legal-reader/web-reader-messages";
import { useAnalytics } from "@/lib/analytics/provider";
import { notifyUserError } from "@/lib/errors/user-toast";

export const useWebReaderPresentationAdapters =
  (): ReaderPresentationAdapters => {
    const t = useTranslations();
    const analytics = useAnalytics();
    return {
      messages: useWebReaderMessages(),
      copyPermalink: async (anchorId) => {
        window.history.replaceState(null, "", `#${anchorId}`);
        const url = new URL(window.location.href);
        url.hash = anchorId;
        const copied = await copyToClipboard(url.href);
        if (Result.isError(copied)) {
          analytics.captureError(copied.error, {
            fingerprintKey:
              "useWebReaderPresentationAdapters.copyPermalink:failure",
            scope: {
              type: "handler",
              handlerId:
                "useWebReaderPresentationAdapters.copyPermalink:failure",
            },
          });
          notifyUserError(copied.error, t("errors.actionFailed"));
          return false;
        }
        return true;
      },
    };
  };

export const WebReaderPresentationProvider = ({
  children,
}: {
  children: ReactNode;
}) => (
  <ReaderPresentationProvider adapters={useWebReaderPresentationAdapters()}>
    {children}
  </ReaderPresentationProvider>
);
