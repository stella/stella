import { createContext, use, useEffect, useEffectEvent, useState } from "react";

import { Result } from "better-result";
import { AppState, View } from "react-native";
import { useTranslations } from "use-intl";

import type { PermissionInput } from "@stll/permissions/role-grants";
import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import { readMyRole, roleCan } from "@/state/role";

/** Where reading the person's role stands. */
type RoleRead =
  | { readonly status: "loading" }
  | { readonly status: "read"; readonly role: string }
  | { readonly status: "failed"; readonly error: ApiError };

type RoleState = {
  readonly read: RoleRead;
  /** A retry of a failed read is on its way. */
  readonly retrying: boolean;
  readonly retry: () => void;
};

const RoleContext = createContext<RoleState | null>(null);

/**
 * The signed-in person's role, read once per sign-in, for every screen to
 * decide what it offers. Until it is read, and while it cannot be, nothing
 * that needs a permission is offered, as the web does while its role loads;
 * a read that failed says so where changes are made (`RoleFailureNotice`)
 * and is tried again from there and when the app comes back to the
 * foreground.
 */
export const RoleProvider = ({ children }: React.PropsWithChildren) => {
  const { end, state } = useSession();
  const source = state.status === "signed-in" ? state.source : null;
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{
    readonly source: AccessTokenSource;
    readonly attempt: number;
    readonly read: RoleRead;
  } | null>(null);

  const settle = useEffectEvent(
    (
      readFor: AccessTokenSource,
      readOn: number,
      role: Result<string, ApiError>,
    ) => {
      if (Result.isError(role) && role.error._tag === "SignedOutError") {
        end(readFor);
        return;
      }
      setSettled({
        source: readFor,
        attempt: readOn,
        read: Result.isOk(role)
          ? { status: "read", role: role.value }
          : { status: "failed", error: role.error },
      });
    },
  );
  useEffect(() => {
    if (source === null) {
      return;
    }
    let current = true;
    void (async () => {
      const role = await readMyRole({ fetch, source });
      if (current) {
        settle(source, attempt, role);
      }
    })();
    return () => {
      current = false;
    };
  }, [attempt, source]);

  // A read settled for an earlier sign-in says nothing of this one.
  const read: RoleRead =
    settled !== null && settled.source === source
      ? settled.read
      : { status: "loading" };
  const retrying =
    read.status === "failed" && settled !== null && settled.attempt < attempt;
  const retry = () => {
    if (read.status === "failed" && !retrying) {
      setAttempt((count) => count + 1);
    }
  };

  // Coming back to the foreground may find the connection back.
  const retryAfterFailure = useEffectEvent(retry);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        retryAfterFailure();
      }
    });
    return () => {
      subscription.remove();
    };
  }, []);

  return (
    <RoleContext value={{ read, retry, retrying }}>{children}</RoleContext>
  );
};

/** Whether the person's role allows `permissions`; false until it is read. */
export const useCan = (permissions: PermissionInput): boolean => {
  const state = use(RoleContext);
  return roleCan(
    state?.read.status === "read" ? state.read.role : null,
    permissions,
  );
};

/**
 * Where changes are made, why they are missing when the role could not be
 * read, with a way to try again; nothing otherwise.
 */
export const RoleFailureNotice = () => {
  const t = useTranslations("role");
  const state = use(RoleContext);
  if (state?.read.status !== "failed") {
    return null;
  }
  return (
    <View className="border-border bg-card gap-2 rounded-xl border p-3">
      <Text variant="caption">{t("readFailed")}</Text>
      <Button
        className="self-start"
        disabled={state.retrying}
        loading={state.retrying}
        onPress={state.retry}
        size="sm"
        variant="outline"
      >
        {t("retry")}
      </Button>
    </View>
  );
};
