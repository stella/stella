import {
  Suspense,
  use,
  useEffect,
  useEffectEvent,
  useState,
  useTransition,
} from "react";

import { randomUUID } from "expo-crypto";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import type {
  LearnedFix,
  LearnedFixChange,
} from "@stll/transcript/learned-fixes";
import { Button } from "@stll/ui/button";
import { Switch } from "@stll/ui/switch";
import { Text } from "@stll/ui/text";

import { syncLearned } from "@/components/learned-fixes-sync";
import type { AccessTokenSource, StoredSession } from "@/connection/session";
import { deviceAccountStore } from "@/native/account-store";
import {
  deleteLearnedFixes,
  readLearnedFixes,
  updateLearnedFixes,
} from "@/state/dictation-learned";

/**
 * The fixes stella learned from how the person corrects dictated words,
 * synced with their other devices: each with a switch, and a way to delete
 * them all, here and there. Fixes still being learned, or corrected another
 * way, are not listed; deleting removes them too. When the phone cannot read
 * them it says so, with a way to try again, and deleting still works. The
 * read lives here, outside the part that waits for it, so waiting does not
 * start it again. Opening the setting, and each change, syncs; the list
 * shows the fixes as kept on the phone after.
 */
export const DictationLearnedSetting = ({
  session,
  source,
}: {
  session: StoredSession;
  source: AccessTokenSource;
}) => {
  const read = async (): Promise<Stored> =>
    await readLearnedFixes(deviceAccountStore, session).then(
      (fixes) => ({ status: "read", fixes }),
      () => ({ status: "unreadable" }),
    );
  const [stored, setStored] = useState(read);
  const [saving, startSaving] = useTransition();

  /** Shows the fixes as kept now, once any sync is done. */
  const syncAndShow = async () => {
    await syncLearned(source).catch(() => undefined);
    const again = read();
    await again;
    setStored(again);
  };

  // Once per opening, after the fixes kept here show; each change syncs on its own.
  const syncOnOpen = useEffectEvent(() => {
    startSaving(syncAndShow);
  });
  useEffect(() => {
    syncOnOpen();
  }, []);

  /** Changes the fixes as kept now, not as last shown, then syncs and shows them. */
  const save = (change: LearnedFixChange) => {
    startSaving(async () => {
      await updateLearnedFixes(deviceAccountStore, session, randomUUID, () => [
        change,
      ]).catch(() => undefined);
      await syncAndShow();
    });
  };

  return (
    <Suspense fallback={null}>
      <LearnedFixes
        onDelete={() => {
          startSaving(async () => {
            await deleteLearnedFixes(deviceAccountStore, session).catch(
              () => undefined,
            );
            await syncAndShow();
          });
        }}
        onRetry={() => {
          startSaving(async () => {
            const again = read();
            await again;
            setStored(again);
          });
        }}
        onSwitch={(from, status) => {
          save({ type: "switched", from, status });
        }}
        saving={saving}
        stored={stored}
      />
    </Suspense>
  );
};

const LearnedFixes = ({
  onDelete,
  onRetry,
  onSwitch,
  saving,
  stored,
}: {
  onDelete: () => void;
  onRetry: () => void;
  onSwitch: (from: string, status: "on" | "off") => void;
  saving: boolean;
  stored: Promise<Stored>;
}) => {
  const t = useTranslations("settings");
  const tChat = useTranslations("chat");
  const kept = use(stored);
  const learned = kept.status === "read" ? kept.fixes : [];
  const listed = learned.filter(
    ({ status }) => status === "on" || status === "off",
  );

  return (
    <>
      <View className="px-1">
        <Text variant="rowTitle">{t("dictationLearnedTitle")}</Text>
      </View>
      {kept.status === "unreadable" ? (
        <View className="flex-row items-center gap-2 px-1">
          <Text className="flex-1" variant="error">
            {t("dictationLearnedUnreadable")}
          </Text>
          <Button disabled={saving} onPress={onRetry} size="sm" variant="ghost">
            {tChat("retry")}
          </Button>
        </View>
      ) : null}
      {kept.status === "read" && listed.length === 0 ? (
        <View className="px-1">
          <Text variant="caption">{t("dictationLearnedEmpty")}</Text>
        </View>
      ) : null}
      {listed.length === 0 ? null : (
        <View className="border-border bg-card rounded-xl border px-4">
          {listed.map((fix, index) => {
            const label = t("dictationLearnedFix", {
              from: fix.from,
              to: fix.to,
            });
            return (
              <View
                className={`flex-row items-center gap-3 py-3 ${
                  index === listed.length - 1 ? "" : "border-border border-b"
                }`}
                key={fix.from}
              >
                <Text className="flex-1">{label}</Text>
                <Switch
                  accessibilityLabel={label}
                  checked={fix.status === "on"}
                  disabled={saving}
                  onCheckedChange={(checked) => {
                    onSwitch(fix.from, checked ? "on" : "off");
                  }}
                />
              </View>
            );
          })}
        </View>
      )}
      <View className="px-1">
        <Text variant="caption">{t("dictationLearnedHint")}</Text>
      </View>
      <Button
        disabled={saving || (kept.status === "read" && learned.length === 0)}
        onPress={onDelete}
        variant="outline"
      >
        {t("dictationLearnedDelete")}
      </Button>
    </>
  );
};

/** The learned fixes as the phone read them, or that it could not. */
type Stored =
  | { readonly status: "read"; readonly fixes: LearnedFix[] }
  | { readonly status: "unreadable" };
