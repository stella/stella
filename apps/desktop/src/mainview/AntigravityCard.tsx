import { useTranslations } from "use-intl";

import { AntigravityLogoIcon } from "@stll/ui/brand-icons";
import { Button } from "@stll/ui/button";

import type { AntigravityStatus } from "./antigravity-status";

/** The member-installed Antigravity CLI: its version and sign-in state. */
export const AntigravityCard = ({
  status,
  onCheckAgain,
}: {
  status: AntigravityStatus;
  onCheckAgain: () => void;
}) => {
  const t = useTranslations("agentSubscriptions");
  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AntigravityLogoIcon className="size-4 shrink-0" />
            <span>{t("antigravity.title")}</span>
          </p>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed text-pretty">
            {t(statusMessage(status))}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button onClick={onCheckAgain} variant="outline">
            {t("antigravity.checkAgain")}
          </Button>
        </div>
      </div>
      {status.state === "not_installed" ? null : (
        <p className="text-muted-foreground text-xs">
          {t("install.ready", {
            name: t("antigravity.title"),
            version: status.version,
          })}
        </p>
      )}
    </div>
  );
};

const STATE_MESSAGES = {
  not_installed: "antigravity.notInstalled",
  too_old: "antigravity.tooOld",
  signed_out: "antigravity.signedOut",
  signed_in: "antigravity.signedIn",
} as const satisfies Record<AntigravityStatus["state"], string>;

const statusMessage = (status: AntigravityStatus) =>
  STATE_MESSAGES[status.state];
