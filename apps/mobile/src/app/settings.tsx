import { Suspense, use, useState, useTransition } from "react";

import * as WebBrowser from "expo-web-browser";
import { ScrollView, View } from "react-native";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Switch } from "@stll/ui/switch";
import { Text } from "@stll/ui/text";

import { screenStyles } from "@/components/empty-state-screen";
import { accountPageUrl } from "@/connection/account-page";
import type { StoredSession } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import {
  readTimerActivityDetails,
  TIMER_ACTIVITY_PUSH,
  writeTimerActivityDetails,
} from "@/native/timer-activity-device";

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
      {TIMER_ACTIVITY_PUSH && session !== null ? (
        <TimerDetailsSetting key={session.signInId} session={session} />
      ) : null}
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

/**
 * Whether a timer changed on another device reaches the Lock Screen with its
 * description and matter, which then pass through Apple's notification
 * service, or with the time alone. The account's own choice on this phone.
 */
const TimerDetailsSetting = ({ session }: { session: StoredSession }) => {
  const t = useTranslations("settings");
  // A phone whose keychain cannot be read shows the default, on.
  const read = async () =>
    await readTimerActivityDetails(session).catch(() => true);
  const [stored, setStored] = useState(read);
  const [saving, startSaving] = useTransition();

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
            disabled={saving}
            label={t("timerDetails")}
            onChange={(next) => {
              // One write at a time, and the switch then shows what was
              // kept, so a failed write never leaves it saying otherwise.
              startSaving(async () => {
                await writeTimerActivityDetails(session, next).catch(
                  () => undefined,
                );
                const kept = read();
                await kept;
                setStored(kept);
              });
            }}
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
  disabled,
  label,
  onChange,
  stored,
}: {
  disabled: boolean;
  label: string;
  onChange: (next: boolean) => void;
  stored: Promise<boolean>;
}) => (
  <Switch
    accessibilityLabel={label}
    checked={use(stored)}
    disabled={disabled}
    onCheckedChange={onChange}
  />
);

export default SettingsScreen;
