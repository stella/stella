import { useState, useTransition } from "react";

import { panic, Result } from "better-result";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslations } from "use-intl";

import { ScreenHeading, screenStyles } from "@/components/empty-state-screen";
import { useSession } from "@/connection/session-provider";
import type { SignInError } from "@/connection/sign-in";
import { PREFILLED_SERVER_URL } from "@/env";
import { useAppColors } from "@/theme";

const SignInScreen = () => {
  const t = useTranslations("signIn");
  const colors = useAppColors();
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
    <SafeAreaView
      style={[screenStyles.screen, { backgroundColor: colors.background }]}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[screenStyles.content, styles.form]}
      >
        <ScreenHeading description={t("description")} title={t("title")} />
        <Text style={[styles.label, { color: colors.text }]}>
          {t("serverLabel")}
        </Text>
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
          placeholderTextColor={colors.muted}
          returnKeyType="go"
          style={[
            styles.input,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              color: colors.text,
            },
          ]}
          textContentType="URL"
          value={serverUrl}
        />
        {notice === null ? null : (
          <Text
            accessibilityLiveRegion="polite"
            style={[styles.notice, { color: colors.text }]}
          >
            {notice}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{
            busy: pending,
            disabled: pending || serverUrl.trim() === "",
          }}
          disabled={pending || serverUrl.trim() === ""}
          onPress={submit}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: colors.accent,
              opacity: pressed || pending ? 0.7 : 1,
            },
          ]}
        >
          {pending ? (
            <ActivityIndicator color={colors.card} />
          ) : (
            <Text style={[styles.buttonLabel, { color: colors.card }]}>
              {t("submit")}
            </Text>
          )}
        </Pressable>
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

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 50,
  },
  buttonLabel: {
    fontSize: 17,
    fontWeight: "600",
  },
  form: {
    gap: 12,
    justifyContent: "center",
  },
  input: {
    borderRadius: 14,
    borderWidth: 1,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 16,
  },
  label: {
    fontSize: 15,
    fontWeight: "600",
    marginTop: 12,
  },
  notice: {
    fontSize: 15,
    lineHeight: 21,
  },
});
