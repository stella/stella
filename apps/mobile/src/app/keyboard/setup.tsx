import { useState, useTransition } from "react";

import { panic } from "better-result";
import { requestRecordingPermissionsAsync } from "expo-audio";
import * as Linking from "expo-linking";
import { Stack } from "expo-router";
import { ScrollView, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { screenStyles } from "@/components/empty-state-screen";
import { useKeyboardStatus } from "@/components/use-keyboard-status";
import { CheckIcon } from "@/icons.gen";
import {
  endKeyboardSession,
  setKeepWarm,
  startKeyboardSession,
} from "@/native/keyboard-dictation";
import { KEEP_WARM_CHOICES } from "@/state/keyboard-dictation";
import type { KeepWarm } from "@/state/keyboard-dictation";
import { useUiColors } from "@/theme";

/**
 * Settings › Dictation › stella keyboard: how to turn the keyboard on, why
 * it asks for Full Access, and how long the app keeps the microphone warm
 * for it.
 */
const KeyboardSetupScreen = () => {
  const t = useTranslations("keyboardDictation");
  const { refresh, status } = useKeyboardStatus();

  return (
    <ScrollView
      alwaysBounceVertical={false}
      className="bg-background flex-1"
      contentContainerStyle={screenStyles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={{ title: t("title") }} />
      <View className="gap-2">
        <View className="px-1">
          <Text accessibilityRole="header" variant="section">
            {t("setupTitle")}
          </Text>
        </View>
        <View className="border-border bg-card gap-3 rounded-xl border p-4">
          {[t("setupAdd"), t("setupFullAccess"), t("setupSwitch")].map(
            (step, index) => (
              <View className="flex-row gap-3" key={step}>
                <Text variant="rowTitle">{index + 1}.</Text>
                <Text className="flex-1">{step}</Text>
              </View>
            ),
          )}
          <Button
            onPress={() => {
              void Linking.openSettings();
            }}
            variant="outline"
          >
            {t("openSettings")}
          </Button>
        </View>
        <View className="px-1">
          <Text variant="caption">
            {status === null || status.keyboardSeenAt === null
              ? t("fullAccessNotSeen")
              : t("fullAccessOn")}
          </Text>
        </View>
      </View>
      <View className="gap-2">
        <View className="px-1">
          <Text accessibilityRole="header" variant="section">
            {t("fullAccessTitle")}
          </Text>
        </View>
        <View className="border-border bg-card rounded-xl border p-4">
          <Text>{t("fullAccessBody")}</Text>
        </View>
      </View>
      {status === null ? null : (
        <KeepWarmSetting
          keepWarm={status.keepWarm}
          onChange={refresh}
          warmUntil={
            status.session.type === "warm" ? status.session.warmUntil : null
          }
        />
      )}
    </ScrollView>
  );
};

/** Why the microphone could not be warmed up. */
type WarmNotice = "denied" | "failed";

const KeepWarmSetting = ({
  keepWarm,
  onChange,
  warmUntil,
}: {
  keepWarm: KeepWarm;
  onChange: () => void;
  warmUntil: number | null;
}) => {
  const t = useTranslations("keyboardDictation");
  const format = useFormatter();
  const ui = useUiColors();
  const [notice, setNotice] = useState<WarmNotice>();
  const [starting, startWarming] = useTransition();

  const label = (choice: KeepWarm) => {
    switch (choice) {
      case 0:
        return t("warmOff");
      case 300:
      case 900:
        return t("warmMinutes", { minutes: choice / 60 });
      case 3600:
        return t("warmHours", { hours: choice / 3600 });
      default:
        choice satisfies never;
        return panic(
          `No label for keeping the microphone warm ${String(choice)} s`,
        );
    }
  };

  return (
    <View className="gap-2">
      <View className="px-1">
        <Text accessibilityRole="header" variant="section">
          {t("warmTitle")}
        </Text>
      </View>
      <View className="border-border bg-card rounded-xl border px-3">
        {KEEP_WARM_CHOICES.map((choice, index) => (
          <Button
            accessibilityRole="radio"
            accessibilityState={{ selected: choice === keepWarm }}
            key={choice}
            onPress={() => {
              setKeepWarm(choice);
              onChange();
            }}
            size="row"
            variant="ghost"
          >
            <View
              className={`flex-1 flex-row items-center gap-3 ${
                index === KEEP_WARM_CHOICES.length - 1
                  ? ""
                  : "border-border border-b"
              }`}
            >
              <Text className="flex-1" variant="rowTitle">
                {label(choice)}
              </Text>
              {choice === keepWarm ? (
                <CheckIcon color={ui.foreground} size={18} />
              ) : null}
            </View>
          </Button>
        ))}
      </View>
      <View className="px-1">
        <Text variant="caption">{t("warmHint")}</Text>
      </View>
      {warmUntil === null && keepWarm !== 0 ? (
        <Button
          disabled={starting}
          loading={starting}
          onPress={() => {
            startWarming(async () => {
              const permission = await requestRecordingPermissionsAsync();
              const started = permission.granted
                ? startKeyboardSession(keepWarm)
                : "denied";
              setNotice(started === "started" ? undefined : started);
              onChange();
            });
          }}
          variant="outline"
        >
          {t("warmStart")}
        </Button>
      ) : null}
      {warmUntil === null ? null : (
        <View className="gap-2">
          <View className="px-1">
            <Text variant="caption">
              {t("warmActive", {
                time: format.dateTime(new Date(warmUntil), {
                  timeStyle: "short",
                }),
              })}
            </Text>
          </View>
          <Button
            onPress={() => {
              endKeyboardSession();
              onChange();
            }}
            variant="outline"
          >
            {t("warmStop")}
          </Button>
        </View>
      )}
      {notice === undefined ? null : (
        <View className="px-1">
          <Text variant="caption">
            {t(notice === "denied" ? "micDenied" : "micFailed")}
          </Text>
        </View>
      )}
    </View>
  );
};

export default KeyboardSetupScreen;
