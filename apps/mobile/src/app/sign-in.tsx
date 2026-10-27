import { useState, useTransition } from "react";

import { panic, Result } from "better-result";
import { KeyboardAvoidingView, Platform, View } from "react-native";
import { useTranslations } from "use-intl";

import { ScreenHeading } from "@/components/empty-state-screen";
import { Button } from "@/components/ui/button";
import { SafeAreaView } from "@/components/ui/safe-area-view";
import { Text, TextInput } from "@/components/ui/text";
import { useSession } from "@/connection/session-provider";
import type { SignInError } from "@/connection/sign-in";
import { PREFILLED_SERVER_URL } from "@/env";

const SignInScreen = () => {
  const t = useTranslations("signIn");
  const { signIn, state } = useSession();
  const [serverUrl, setServerUrl] = useState(PREFILLED_SERVER_URL);
  const [failure, setFailure] = useState<SignInFailure | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    startTransition(async () => {
      const result = await signIn(serverUrl);
      setFailure(Result.isError(result) ? failureOf(result.error) : null);
    });
  };

  const sessionEnded = state.status === "signed-out" && state.ended;
  let notice: string | null = null;
  if (failure !== null) {
    notice = t(`errors.${failure}`);
  } else if (sessionEnded) {
    notice = t("sessionEnded");
  }

  return (
    <SafeAreaView>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 justify-center gap-3 px-4"
      >
        <ScreenHeading description={t("description")} title={t("title")} />
        <View className="mt-4">
          <Text variant="label">{t("serverLabel")}</Text>
        </View>
        <TextInput
          accessibilityLabel={t("serverLabel")}
          autoCapitalize="none"
          autoComplete="url"
          autoCorrect={false}
          editable={!pending}
          inputMode="url"
          onChangeText={setServerUrl}
          onSubmitEditing={submit}
          placeholder={t("serverPlaceholder")}
          returnKeyType="go"
          textContentType="URL"
          value={serverUrl}
        />
        {notice === null ? null : (
          <Text accessibilityLiveRegion="polite" variant="error">
            {notice}
          </Text>
        )}
        <Button
          className="mt-2"
          disabled={pending || serverUrl.trim() === ""}
          label={t("submit")}
          loading={pending}
          onPress={submit}
          size="lg"
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

export default SignInScreen;

type SignInFailure = "address" | "unreachable" | "denied" | "failed";

/**
 * What the person is told, by failure kind. Closing the browser is their own
 * choice and says nothing; an attempt the server cannot vouch for is a plain
 * failure, never a hint about why.
 */
function failureOf(error: SignInError): SignInFailure | null {
  switch (error._tag) {
    case "ServerUrlError":
      return "address";
    case "DiscoveryError":
    case "ClientRegistrationError":
      return "unreachable";
    case "AuthorizationError":
      switch (error.failure) {
        case "cancelled":
          return null;
        case "denied":
          return "denied";
        case "mismatched":
        case "malformed":
          return "failed";
        default:
          error.failure satisfies never;
          return panic("Unhandled authorization failure");
      }
    case "TokenError":
      return "failed";
    default:
      error satisfies never;
      return panic("Unhandled sign-in error");
  }
}
