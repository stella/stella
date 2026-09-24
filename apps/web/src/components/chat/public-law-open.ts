import { Result } from "better-result";

import { stellaToast } from "@stll/ui/toast";

import { isPublicLawPreviewEnabled } from "@/hooks/use-public-law-preview";
import { getTranslator } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

type OpenPublicLawLinkOptions<Resolved> = {
  /** What the link names, or null when nothing answers to it. */
  resolve: () => Promise<Resolved | null>;
  open: (resolved: Resolved) => Promise<void> | void;
};

/**
 * Follow a chat link to a public-law record (a decision, a statute). The
 * surface is gated, a link naming nothing is a failed action, and every
 * failure reaches the reader as a toast and analytics as an error.
 */
export const openPublicLawLink = async <Resolved>({
  open,
  resolve,
}: OpenPublicLawLinkOptions<Resolved>) => {
  const t = getTranslator();
  if (!isPublicLawPreviewEnabled()) {
    stellaToast.add({ title: t("common.comingSoon"), type: "neutral" });
    return;
  }

  const result = await Result.tryPromise(async () => {
    const resolved = await resolve();
    if (resolved === null) {
      return false;
    }
    await open(resolved);
    return true;
  });

  if (Result.isError(result)) {
    getAnalytics().captureError(result.error.cause);
    stellaToast.add({
      title: userErrorFromThrown(result.error.cause, t("errors.actionFailed")),
      type: "error",
    });
    return;
  }

  if (!result.value) {
    stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
  }
};
