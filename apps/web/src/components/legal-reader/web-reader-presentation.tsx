import type { ReactNode } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { copyToClipboard } from "@stll/clipboard";
import { ReaderPresentationProvider } from "@stll/decision-reader/reader-adapters";
import type { ReaderPresentationAdapters } from "@stll/decision-reader/reader-adapters";
import { stellaToast } from "@stll/ui/toast";

import { useWebReaderMessages } from "@/components/legal-reader/web-reader-messages";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";

export const useWebReaderPresentationAdapters =
  (): ReaderPresentationAdapters => {
    const t = useTranslations();
    const analytics = useAnalytics();
    return {
      messages: useWebReaderMessages(),
      copyPermalink: (anchorId) => {
        window.history.replaceState(null, "", `#${anchorId}`);
        detached(
          (async () => {
            const url = new URL(window.location.href);
            url.hash = anchorId;
            const copied = await copyToClipboard(url.href);
            if (Result.isError(copied)) {
              analytics.captureError(copied.error);
              notifyUserError(copied.error, t("errors.actionFailed"));
              return;
            }
            stellaToast.add({ title: t("common.copied"), type: "success" });
          })(),
          "legal-reader.permalink-copy",
        );
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
