import { useTransition } from "react";

import { View } from "react-native";
import { useTranslations } from "use-intl";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSession } from "@/connection/session-provider";
import { needsConsent } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/** Why a change did not save: a scope the sign-in never granted, or anything else. */
export type WriteFailure = "consent" | "failed";

export const writeFailure = (error: ApiError): WriteFailure =>
  needsConsent(error) ? "consent" : "failed";

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
  if (failure === "failed") {
    return <Text variant="error">{message}</Text>;
  }
  return (
    <View className="gap-3">
      <Text variant="caption">{t("consentNeeded")}</Text>
      <Button
        disabled={leaving}
        label={t("signInAgain")}
        loading={leaving}
        onPress={() => {
          startLeaving(async () => {
            await signOut();
          });
        }}
        variant="outline"
      />
    </View>
  );
};
