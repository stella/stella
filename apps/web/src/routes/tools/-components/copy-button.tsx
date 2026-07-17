import { useState } from "react";

import { Result } from "better-result";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import { getAnalytics } from "@/lib/analytics/provider";
import { copyToClipboard } from "@/lib/copy-to-clipboard";

// Client-only: reads `navigator.clipboard`. Lazy-loaded by the detail
// page so it never runs during SSR.
export function CopyButton({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const result = await copyToClipboard(text);
    if (Result.isError(result)) {
      stellaToast.add({ title: t("common.unexpectedError"), type: "error" });
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      className={className}
      onClick={() => {
        copy().catch((error: unknown) => {
          getAnalytics().captureError(error);
        });
      }}
      size="xs"
      type="button"
      variant="outline"
    >
      {copied ? (
        <CheckIcon className="size-3.5" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
      {copied ? t("common.copied") : t("common.copy")}
    </Button>
  );
}
