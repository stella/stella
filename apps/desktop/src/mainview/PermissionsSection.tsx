import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Separator } from "@stll/ui/separator";

import {
  isPermissionsSnapshot,
  PERMISSION_REFRESH_MS,
} from "../shared/permissions";
import type { PermissionsSnapshot } from "../shared/permissions";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import type { DesktopTelemetryWindow } from "../telemetry/desktop-telemetry";
import { PermissionRow } from "./PermissionRow";

/**
 * Live status of the system permissions the app needs on this computer. It
 * re-reads while visible because the changes happen in system settings,
 * which notify no one.
 */
export const PermissionsSection = ({
  only,
  window: telemetryWindow,
}: {
  only?: readonly PermissionsSnapshot["rows"][number]["permission"][];
  window: DesktopTelemetryWindow;
}) => {
  const [snapshot, setSnapshot] = useState<PermissionsSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  // Polls, focus, visibility and user actions read concurrently; only the
  // most recently issued read may set the snapshot, so a slow older read
  // cannot overwrite a newer one.
  const latestRead = useRef(0);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const refresh = async () => {
      latestRead.current += 1;
      const read = latestRead.current;
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("permissions_get_snapshot"),
      );
      if (disposed) {
        return;
      }
      // One pending poll at a time, however many reads overlapped.
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") {
        timer = window.setTimeout(() => {
          void refresh();
        }, PERMISSION_REFRESH_MS);
      }
      if (read !== latestRead.current) {
        return;
      }
      if (Result.isError(result) || !isPermissionsSnapshot(result.value)) {
        reportPermissionsFailure(telemetryWindow);
        setFailed(true);
        return;
      }
      setFailed(false);
      setSnapshot(result.value);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };
    void refresh();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [telemetryWindow]);

  const apply = async (run: () => Promise<unknown>) => {
    const result = await Result.tryPromise(run);
    if (Result.isError(result)) {
      reportPermissionsFailure(telemetryWindow);
      setFailed(true);
      return;
    }
    // Taken once the action has finished, so a poll issued while it ran
    // (for example during a system prompt) cannot win with the old state.
    latestRead.current += 1;
    const read = latestRead.current;
    const next = isPermissionsSnapshot(result.value)
      ? Result.ok(result.value)
      : await Result.tryPromise(async () =>
          invoke<unknown>("permissions_get_snapshot"),
        );
    if (read !== latestRead.current) {
      return;
    }
    if (Result.isOk(next) && isPermissionsSnapshot(next.value)) {
      setSnapshot(next.value);
    }
  };

  return (
    <PermissionsContent
      apply={apply}
      failed={failed}
      snapshot={
        snapshot && only
          ? {
              rows: snapshot.rows.filter(({ permission }) =>
                only.includes(permission),
              ),
            }
          : snapshot
      }
    />
  );
};

type PermissionsContentProps = {
  failed: boolean;
  apply: (run: () => Promise<unknown>) => Promise<void>;
  snapshot: PermissionsSnapshot | null;
};

const PermissionsContent = ({
  apply,
  failed,
  snapshot,
}: PermissionsContentProps) => {
  const t = useTranslations("settings");
  return (
    <>
      {snapshot?.rows.map((row, index) => (
        <div key={row.permission}>
          {index > 0 ? <Separator /> : null}
          <PermissionRow
            onOpenSettings={() => {
              void apply(async () =>
                invoke("permissions_open_settings", {
                  permission: row.permission,
                }),
              );
            }}
            onRequest={() => {
              void apply(async () =>
                invoke<unknown>("permissions_request", {
                  permission: row.permission,
                }),
              );
            }}
            onTurnOff={() => {
              void apply(async () =>
                invoke<boolean>("set_autostart", { enabled: false }),
              );
            }}
            row={row}
          />
        </div>
      ))}
      {failed ? (
        <p
          className="text-destructive-foreground border-t px-4 py-3 text-sm"
          role="alert"
        >
          {t("errorPermissions")}
        </p>
      ) : null}
    </>
  );
};

function reportPermissionsFailure(window: DesktopTelemetryWindow) {
  reportDesktopError({
    code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
    operation: DESKTOP_TELEMETRY_OPERATIONS.permissionsUpdate,
    window,
  });
}
