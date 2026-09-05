import { Result } from "better-result";
import { CopyIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/input-group";
import { stellaToast } from "@stll/ui/toast";

import { getAnalytics } from "@/lib/analytics/provider";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { detached } from "@/lib/detached";

type CopyFieldProps = {
  label: string;
  value: string;
};

/** A read-only value with a copy-to-clipboard button, used for the MCP
 * server URL and CLI commands on the connections settings page and in
 * the onboarding setup preview. */
export const CopyField = ({ label, value }: CopyFieldProps) => {
  const t = useTranslations();

  const handleCopy = async () => {
    const copied = await copyToClipboard(value);
    if (Result.isError(copied)) {
      getAnalytics().captureError(copied.error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    stellaToast.add({ title: t("common.copied"), type: "success" });
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <InputGroup>
        <InputGroupInput className="font-mono text-sm" readOnly value={value} />
        <InputGroupAddon align="inline-end">
          <Button
            aria-label={t("common.copy")}
            onClick={() => {
              detached(handleCopy(), "copy-field.copy");
            }}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <CopyIcon />
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
};
