import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { downloadPercent } from "./harness-install-status";
import type {
  HarnessInstallFailure,
  HarnessInstallState,
} from "./harness-install-status";

/**
 * One managed agent CLI's install: its progress, the installed version, or
 * what failed, and the action that moves it on.
 */
export const HarnessInstallLine = ({
  name,
  state,
  onInstall,
  onCancel,
}: {
  /** The CLI's product name, never translated. */
  name: string;
  state: HarnessInstallState;
  onInstall: () => void;
  onCancel: (operationId: string) => void;
}) => {
  const t = useTranslations("agentSubscriptions");
  if (state.state === "ready") {
    return (
      <p className="text-muted-foreground text-xs">
        {t("install.ready", { name, version: state.active })}
      </p>
    );
  }
  if (state.state === "downloading" || state.state === "verifying") {
    const operationId = state.operationId;
    return (
      <div className="flex items-center justify-between gap-4">
        <p
          className="text-muted-foreground min-w-0 flex-1 text-sm tabular-nums"
          role="status"
        >
          {state.state === "downloading"
            ? t("install.downloading", {
                name,
                version: state.version,
                percent: downloadPercent(state),
              })
            : t("install.verifying", { name, version: state.version })}
        </p>
        <Button
          onClick={() => {
            onCancel(operationId);
          }}
          size="sm"
          variant="outline"
        >
          {t("cancel")}
        </Button>
      </div>
    );
  }
  if (state.state === "failed") {
    return (
      <div className="flex items-center justify-between gap-4">
        <p
          className="text-destructive-foreground min-w-0 flex-1 text-sm"
          role="alert"
        >
          {t(FAILURE_MESSAGES[state.reason], { name })}
          {state.active === null
            ? null
            : ` ${t("install.activeStays", { version: state.active })}`}
        </p>
        <Button onClick={onInstall} size="sm" variant="outline">
          {t("install.retry")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-muted-foreground min-w-0 flex-1 text-sm">
        {t("install.notInstalled", { name })}
      </p>
      <Button onClick={onInstall} size="sm">
        {t("install.install")}
      </Button>
    </div>
  );
};

const FAILURE_MESSAGES = {
  download_failed: "install.failure.download",
  oversize: "install.failure.verification",
  incomplete: "install.failure.download",
  digest_mismatch: "install.failure.verification",
  archive_rejected: "install.failure.verification",
  probe_failed: "install.failure.verification",
  storage: "install.failure.storage",
  corrupt_install: "install.failure.storage",
} as const satisfies Record<HarnessInstallFailure, `install.failure.${string}`>;
