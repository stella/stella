import { useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { useNativeStatus } from "./AgentSubscriptionsSection";
import {
  isSigningDriverStatus,
  SIGNING_DRIVER_CHANGED_EVENT,
} from "./signing-driver-status";
import type { SigningDriverNotice } from "./signing-driver-status";

const readSigningDriver = async () => invoke<unknown>("signing_driver_get");

/**
 * The PKCS #11 module of a smart card or token whose driver stella desktop
 * does not find on its own. The module is loaded only by the separate
 * helper process that signs PDFs. It renders nothing where the native side
 * refuses the read (any platform but macOS).
 */
export const SigningDriverSection = ({
  renderGroup,
}: {
  renderGroup: (content: React.JSX.Element) => React.JSX.Element;
}) => {
  const t = useTranslations("signingDriver");
  const [driver, refresh] = useNativeStatus({
    read: readSigningDriver,
    event: SIGNING_DRIVER_CHANGED_EVENT,
    isStatus: isSigningDriverStatus,
  });
  const [failed, setFailed] = useState(false);
  const [picking, setPicking] = useState(false);

  if (driver === null) {
    return null;
  }

  const send = async (command: () => Promise<unknown>) => {
    setFailed(false);
    const result = await Result.tryPromise(command);
    setFailed(Result.isError(result));
    // Shown at once, without waiting for the change event.
    refresh();
  };
  const notice: SigningDriverNotice | null = failed
    ? "action_failed"
    : driver.problem;

  return renderGroup(
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground min-w-0 flex-1 text-sm leading-relaxed">
          {t("description")}
        </p>
        <Button
          disabled={picking}
          onClick={() => {
            setPicking(true);
            void send(async () => invoke("signing_driver_pick")).then(() => {
              setPicking(false);
              return undefined;
            });
          }}
          size="sm"
          variant="outline"
        >
          {t("choose")}
        </Button>
      </div>
      {driver.path === null ? null : (
        <div className="flex items-center justify-between gap-4">
          <p className="min-w-0 flex-1 text-xs break-all">{driver.path}</p>
          <Button
            onClick={() => {
              void send(async () => invoke("signing_driver_remove"));
            }}
            size="sm"
            variant="ghost"
          >
            {t("remove")}
          </Button>
        </div>
      )}
      {notice === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {t(`notice.${notice}`)}
        </p>
      )}
    </div>,
  );
};
