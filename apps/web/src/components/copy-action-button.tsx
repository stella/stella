import type { ComponentProps } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { copyToClipboard } from "@stll/clipboard";
import { CopyButton } from "@stll/ui/copy-button";

import { getAnalytics } from "@/lib/analytics/provider";
import { notifyUserError } from "@/lib/errors/user-toast";

type CopyActionButtonProps = Omit<
  ComponentProps<typeof CopyButton>,
  "copiedLabel" | "label" | "onCopy"
> & {
  text: string;
};

/**
 * The app's copy action: `CopyButton` confirms in place, and only a failed
 * copy raises a toast.
 */
export const CopyActionButton = ({ text, ...props }: CopyActionButtonProps) => {
  const t = useTranslations();

  const copy = async () => {
    const copied = await copyToClipboard(text);
    if (Result.isError(copied)) {
      getAnalytics().captureError(copied.error);
      notifyUserError(copied.error, t("errors.actionFailed"));
      return false;
    }
    return true;
  };

  return (
    <CopyButton
      {...props}
      copiedLabel={t("common.copied")}
      label={t("common.copy")}
      onCopy={copy}
    />
  );
};
