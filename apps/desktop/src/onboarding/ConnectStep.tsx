import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";

import { StellaAppIcon } from "../shared/StellaAppIcon";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import type { StepProps } from "./step-props";
import { StepFooter } from "./StepFooter";

type LinkedAccount = { email: string; name: string | null };

export const ConnectStep = ({ onBack, onContinue, snapshot }: StepProps) => {
  const t = useTranslations("onboarding");
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [account, setAccount] = useState<LinkedAccount | null>(null);

  useEffect(() => {
    if (!snapshot.linked) {
      return undefined;
    }
    let disposed = false;
    void Result.tryPromise(async () =>
      invoke<unknown>("account_get_state"),
    ).then((result) => {
      if (!disposed && Result.isOk(result)) {
        setAccount(linkedAccount(result.value));
      }
      return undefined;
    });
    return () => {
      disposed = true;
    };
  }, [snapshot.linked]);

  const signIn = async () => {
    setFailed(false);
    const result = await Result.tryPromise(async () =>
      invoke("open_stella_account"),
    );
    if (Result.isError(result)) {
      reportDesktopError({
        code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
        window: DESKTOP_TELEMETRY_WINDOWS.onboarding,
      });
      setFailed(true);
      return;
    }
    setWaiting(true);
  };

  return (
    <>
      <h1 className="text-xl font-semibold">{t("connectTitle")}</h1>
      <p className="text-muted-foreground mt-1 max-w-md text-sm leading-relaxed">
        {waiting && !snapshot.linked ? t("connectWaiting") : t("connectBody")}
      </p>
      <div className="bg-card mt-5 flex items-center gap-3 rounded-xl border px-4 py-3">
        <StellaAppIcon className="size-9 rounded-lg" />
        <div className="min-w-0 flex-1">
          {snapshot.linked && account ? (
            <BidiText as="p" className="truncate text-sm font-medium">
              {account.name ?? account.email}
            </BidiText>
          ) : (
            <p className="truncate text-sm font-medium">
              {snapshot.linked
                ? t("connectConnected")
                : t("connectNotConnected")}
            </p>
          )}
          {snapshot.linked && account?.name ? (
            <BidiText
              as="p"
              className="text-muted-foreground truncate text-sm"
              direction="ltr"
            >
              {account.email}
            </BidiText>
          ) : null}
        </div>
        {snapshot.linked ? (
          <span className="text-success-foreground text-sm font-medium">
            {t("connectConnected")}
          </span>
        ) : (
          <Button
            onClick={() => {
              void signIn();
            }}
          >
            {t("connectSignIn")}
          </Button>
        )}
      </div>
      {failed ? (
        <p className="text-destructive-foreground mt-3 text-sm" role="alert">
          {t("connectFailed")}
        </p>
      ) : null}
      <StepFooter
        onBack={onBack}
        primary={
          <Button disabled={!snapshot.linked} onClick={onContinue}>
            {t("continue")}
          </Button>
        }
        secondary={
          snapshot.linked ? null : (
            <Button onClick={onContinue} variant="ghost">
              {t("skip")}
            </Button>
          )
        }
        snapshot={snapshot}
      />
    </>
  );
};

function linkedAccount(value: unknown): LinkedAccount | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("status" in value) ||
    value.status !== "connected" ||
    !("account" in value) ||
    typeof value.account !== "object" ||
    value.account === null ||
    !("email" in value.account) ||
    typeof value.account.email !== "string"
  ) {
    return null;
  }
  const name =
    "name" in value.account && typeof value.account.name === "string"
      ? value.account.name
      : null;
  return { email: value.account.email, name };
}
