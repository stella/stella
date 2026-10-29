import { useState, useTransition } from "react";
import type { ReactNode } from "react";

import { panic, Result } from "better-result";
import * as WebBrowser from "expo-web-browser";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { StellaWordmarkLatin } from "@stll/ui/stella-wordmark";
import { Text } from "@stll/ui/text";

import { TERMS_URL } from "@/components/auth-backdrop";
import { AuthBackdrop } from "@/components/auth-backdrop-view";
import { useSession } from "@/connection/session-provider";
import type { SignInError } from "@/connection/sign-in";
import { DEFAULT_SERVER_URL } from "@/env";
import { MoreHorizontalIcon } from "@/icons.gen";
import { useUiColors } from "@/theme";

/** The widest the sign-in panel grows. */
const SIGN_IN_MAX_WIDTH = 520;

/**
 * The web sign-in, on the phone: its backdrop, wordmark and beta mark, its
 * headline, and one way in. The web page itself takes the sign-in in the
 * browser sheet, so every method it offers is offered here too. The server
 * is stella's own; another one hides behind the options button, where the
 * web keeps its pickers.
 */
const SignInScreen = () => {
  const t = useTranslations("signIn");
  const ui = useUiColors();
  const insets = useSafeAreaInsets();
  const { signIn, state } = useSession();
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [failure, setFailure] = useState<SignInFailure | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setOptionsOpen(false);
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
    <View className="flex-1">
      <AuthBackdrop />
      {/* On an iPad the panel keeps a phone's measure, centred, as the web's
          auth panel does on a wide screen. */}
      <View
        className="w-full flex-1 self-center px-8"
        style={{
          maxWidth: SIGN_IN_MAX_WIDTH,
          paddingBottom: insets.bottom + 24,
          paddingTop: insets.top + 24,
        }}
      >
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-3">
            <StellaWordmarkLatin height={24} />
            <View className="border-border rounded-sm border px-1.5 py-0.5">
              <Text variant="badge">{t("beta")}</Text>
            </View>
          </View>
          <Pressable
            accessibilityLabel={t("options")}
            accessibilityRole="button"
            className="size-11 items-center justify-center rounded-full active:opacity-60"
            hitSlop={8}
            onPress={() => {
              setOptionsOpen(true);
            }}
          >
            <MoreHorizontalIcon color={ui.mutedForeground} size={20} />
          </Pressable>
        </View>
        <View className="flex-1 justify-center gap-5">
          <Text accessibilityRole="header" variant="display">
            {t("headline")}
          </Text>
          <Text variant="caption">{t("subtitle")}</Text>
        </View>
        <View className="gap-4">
          {notice === null ? null : (
            <Text accessibilityLiveRegion="polite" variant="error">
              {notice}
            </Text>
          )}
          <Button
            disabled={pending || serverUrl.trim() === ""}
            loading={pending}
            onPress={submit}
            size="lg"
          >
            {t("submit")}
          </Button>
          <Text variant="caption">
            {t.rich("terms", {
              terms: (chunks: ReactNode) => (
                <Text
                  accessibilityRole="link"
                  onPress={() => {
                    void WebBrowser.openBrowserAsync(TERMS_URL);
                  }}
                  variant="link"
                >
                  {chunks}
                </Text>
              ),
            })}
          </Text>
        </View>
      </View>
      <Modal
        animationType="slide"
        onRequestClose={() => {
          setOptionsOpen(false);
        }}
        presentationStyle="pageSheet"
        visible={optionsOpen}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          className="bg-background flex-1 gap-4 px-5 pt-5"
        >
          <View className="flex-row items-center justify-between">
            <Text variant="headline">{t("options")}</Text>
            <Button
              onPress={() => {
                setOptionsOpen(false);
              }}
              size="sm"
              variant="ghost"
            >
              {t("done")}
            </Button>
          </View>
          <View className="gap-2">
            <Text variant="label">{t("serverTitle")}</Text>
            <Text variant="caption">{t("serverDescription")}</Text>
          </View>
          <Input
            accessibilityLabel={t("serverLabel")}
            autoCapitalize="none"
            autoComplete="url"
            autoCorrect={false}
            disabled={pending}
            inputMode="url"
            onChangeText={setServerUrl}
            onSubmitEditing={submit}
            placeholder={t("serverPlaceholder")}
            returnKeyType="go"
            textContentType="URL"
            value={serverUrl}
          />
          {serverUrl === DEFAULT_SERVER_URL ? null : (
            <Button
              onPress={() => {
                setServerUrl(DEFAULT_SERVER_URL);
              }}
              variant="outline"
            >
              {t("useStella")}
            </Button>
          )}
        </KeyboardAvoidingView>
      </Modal>
    </View>
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
