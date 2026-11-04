import { Suspense, use, useState, useTransition } from "react";

import * as WebBrowser from "expo-web-browser";
import { ScrollView, View } from "react-native";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Switch } from "@stll/ui/switch";
import { Text } from "@stll/ui/text";

import { screenStyles } from "@/components/empty-state-screen";
import { accountPageUrl } from "@/connection/account-page";
import { useSession } from "@/connection/session-provider";
import {
  readTimerActivityDetails,
  TIMER_ACTIVITY_PUSH,
  writeTimerActivityDetails,
} from "@/native/timer-activity-device";

/**
 * Whether a timer changed on another device reaches the Lock Screen with its
 * description and matter, which then pass through Apple's notification
 * service, or with the time alone.
 */
const TimerDetailsSetting = () => {
  const t = useTranslations("settings");
  const [stored] = useState(readTimerActivityDetails);
  const [shown, setShown] = useState<boolean | null>(null);

  return (
    <View className="gap-2">
      <View className="px-1">
        <Text accessibilityRole="header" variant="section">
          {t("lockScreenTitle")}
        </Text>
      </View>
      <View className="border-border bg-card flex-row items-center gap-3 rounded-xl border p-4">
        <Text className="flex-1">{t("timerDetails")}</Text>
        <Suspense fallback={null}>
          <StoredSwitch
            label={t("timerDetails")}
            onChange={(next) => {
              setShown(next);
              void writeTimerActivityDetails(next);
            }}
            shown={shown}
            stored={stored}
          />
        </Suspense>
      </View>
      <View className="px-1">
        <Text variant="caption">{t("timerDetailsHint")}</Text>
      </View>
    </View>
  );
};

const StoredSwitch = ({
  label,
  onChange,
  shown,
  stored,
}: {
  label: string;
  onChange: (next: boolean) => void;
  shown: boolean | null;
  stored: Promise<boolean>;
}) => {
  const initial = use(stored);
  return (
    <Switch
      accessibilityLabel={label}
      checked={shown ?? initial}
      onCheckedChange={onChange}
    />
  );
};

const SettingsScreen = () => {
  const t = useTranslations();
  const { signOut, state } = useSession();
  const [pending, startTransition] = useTransition();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const session =
    state.status === "signed-in" ? (state.source.session() ?? null) : null;
  const serverUrl = session?.serverUrl ?? null;

  return (
    // The sheet's own bar carries the title and the close button.
    <ScrollView
      alwaysBounceVertical={false}
      className="bg-background flex-1"
      contentContainerStyle={screenStyles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View className="gap-2">
        <View className="px-1">
          <Text accessibilityRole="header" variant="section">
            {t("settings.accountTitle")}
          </Text>
        </View>
        <View className="border-border bg-card gap-1 rounded-xl border p-4">
          <Text variant="caption">{t("settings.server")}</Text>
          <Text selectable>{serverUrl}</Text>
        </View>
      </View>
      {TIMER_ACTIVITY_PUSH ? <TimerDetailsSetting /> : null}
      {session === null ? null : (
        <View className="gap-2">
          <Button
            onPress={() => {
              void WebBrowser.openBrowserAsync(accountPageUrl(session.issuer));
            }}
            variant="outline"
          >
            {t("settings.deleteAccount")}
          </Button>
          <View className="px-1">
            <Text variant="caption">{t("settings.deleteAccountHint")}</Text>
          </View>
        </View>
      )}
      <Button
        disabled={pending}
        loading={pending}
        onPress={() => {
          startTransition(async () => {
            const outcome = await signOut();
            setSignOutFailed(outcome.isErr());
          });
        }}
        variant="destructive-outline"
      >
        {t("settings.signOut")}
      </Button>
      {signOutFailed ? (
        <Text variant="caption">{t("settings.signOutFailed")}</Text>
      ) : null}
    </ScrollView>
  );
};

export default SettingsScreen;
