import { useEffect, useState } from "react";

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
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import { PermissionRow } from "./PermissionRow";

/**
 * Live status of the system permissions the app needs on this computer. It
 * re-reads while visible because the changes happen in system settings,
 * which notify no one.
 */
export const PermissionsSection = () => {
  const t = useTranslations("settings");
  const [snapshot, setSnapshot] = useState<PermissionsSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const refresh = async () => {
      window.clearTimeout(timer);
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("permissions_get_snapshot"),
      );
      if (disposed) {
        return;
      }
      if (Result.isError(result) || !isPermissionsSnapshot(result.value)) {
        reportPermissionsFailure();
        setFailed(true);
      } else {
        setFailed(false);
        setSnapshot(result.value);
      }
      if (document.visibilityState === "visible") {
        timer = window.setTimeout(() => {
          void refresh();
        }, PERMISSION_REFRESH_MS);
      }
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
  }, []);

  const apply = async (run: () => Promise<unknown>) => {
    const result = await Result.tryPromise(run);
    if (Result.isError(result)) {
      reportPermissionsFailure();
      setFailed(true);
      return;
    }
    const next = isPermissionsSnapshot(result.value)
      ? Result.ok(result.value)
      : await Result.tryPromise(async () =>
          invoke<unknown>("permissions_get_snapshot"),
        );
    if (Result.isOk(next) && isPermissionsSnapshot(next.value)) {
      setSnapshot(next.value);
    }
  };

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

function reportPermissionsFailure() {
  reportDesktopError({
    code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
    operation: DESKTOP_TELEMETRY_OPERATIONS.permissionsUpdate,
    window: DESKTOP_TELEMETRY_WINDOWS.main,
  });
}
