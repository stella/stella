import { use, useState, useTransition } from "react";

import { View } from "react-native";
import { useTranslations } from "use-intl";

import type { LearnedFix } from "@stll/transcript/corrections";
import { Button } from "@stll/ui/button";
import { Switch } from "@stll/ui/switch";
import { Text } from "@stll/ui/text";

import type { StoredSession } from "@/connection/session";
import { deviceAccountStore } from "@/native/account-store";
import { readLearnedFixes, writeLearnedFixes } from "@/state/dictation-learned";

/**
 * The fixes stella learned from how the person corrects dictated words on
 * this phone: each with a switch, and a way to delete them all. Fixes still
 * being learned, or corrected another way, are not listed; deleting removes
 * them too. When the phone cannot read them it says so, with a way to try
 * again, and deleting still works.
 */
export const DictationLearnedSetting = ({
  session,
}: {
  session: StoredSession;
}) => {
  const t = useTranslations("settings");
  const tChat = useTranslations("chat");
  const read = async (): Promise<Stored> =>
    await readLearnedFixes(deviceAccountStore, session).then(
      (fixes) => ({ status: "read", fixes }),
      () => ({ status: "unreadable" }),
    );
  const [stored, setStored] = useState(read);
  const [saving, startSaving] = useTransition();
  const kept = use(stored);
  const learned = kept.status === "read" ? kept.fixes : [];
  const listed = learned.filter(
    ({ status }) => status === "on" || status === "off",
  );
  const reread = () => {
    startSaving(async () => {
      const again = read();
      await again;
      setStored(again);
    });
  };

  const save = (change: (current: LearnedFix[]) => LearnedFix[]) => {
    startSaving(async () => {
      const current = await stored;
      // A list that could not be read can only be deleted.
      if (current.status === "read") {
        await writeLearnedFixes(
          deviceAccountStore,
          session,
          change(current.fixes),
        ).catch(() => undefined);
      }
      const again = read();
      await again;
      setStored(again);
    });
  };

  const remove = () => {
    startSaving(async () => {
      await writeLearnedFixes(deviceAccountStore, session, []).catch(
        () => undefined,
      );
      const again = read();
      await again;
      setStored(again);
    });
  };

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
          <Button disabled={saving} onPress={reread} size="sm" variant="ghost">
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
                    save((current) =>
                      current.map((each) =>
                        each.from === fix.from
                          ? { ...each, status: checked ? "on" : "off" }
                          : each,
                      ),
                    );
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
        onPress={remove}
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
