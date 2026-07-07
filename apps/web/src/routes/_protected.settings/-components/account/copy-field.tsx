import { CopyIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/components/input-group";
import { stellaToast } from "@stll/ui/components/toast";

type CopyFieldProps = {
  label: string;
  value: string;
};

/** A read-only value with a copy-to-clipboard button, used for the MCP
 * server URL and CLI commands on the connections settings page. */
export const CopyField = ({ label, value }: CopyFieldProps) => {
  const t = useTranslations();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      stellaToast.add({ title: t("common.copied"), type: "success" });
    } catch {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    }
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
              void handleCopy();
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
