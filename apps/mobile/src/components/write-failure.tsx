import { useTransition } from "react";

import { View } from "react-native";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { useSession } from "@/connection/session-provider";
import { needsConsent } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/**
 * Why a change did not save: a scope the sign-in never granted, or anything
 * else, with the server's own explanation when it gave one.
 */
export type WriteFailure =
  | { readonly kind: "consent" }
  | { readonly kind: "failed"; readonly detail: string | undefined };

export const writeFailure = (error: ApiError): WriteFailure => {
  if (needsConsent(error)) {
    return { kind: "consent" };
  }
  return {
    kind: "failed",
    detail: error._tag === "ApiRequestError" ? error.detail : undefined,
  };
};

/**
 * What a sheet says when a change did not save. A sign-in from before the
 * app asked to make changes lacks the permission, so it offers to sign in
 * again, which asks for it; anything else says what failed.
 */
export const WriteFailureNotice = ({
  failure,
  message,
}: {
  failure: WriteFailure | null;
  /** What did not save, said when the cause is not a missing permission. */
  message: string;
}) => {
  const t = useTranslations("writes");
  const { signOut } = useSession();
  const [leaving, startLeaving] = useTransition();

  if (failure === null) {
    return null;
  }
  if (failure.kind === "failed") {
    return (
      <View className="gap-1">
        <Text variant="error">{message}</Text>
        {failure.detail === undefined ? null : (
          // The server's own words, which it writes in English.
          <Text variant="caption">{failure.detail}</Text>
        )}
      </View>
    );
  }
  return (
    <View className="gap-3">
      <Text variant="caption">{t("consentNeeded")}</Text>
      <Button
        disabled={leaving}
        loading={leaving}
        onPress={() => {
          startLeaving(async () => {
            await signOut();
          });
        }}
        variant="outline"
      >
        {t("signInAgain")}
      </Button>
    </View>
  );
};
