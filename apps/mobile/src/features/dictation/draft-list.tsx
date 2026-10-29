import { View } from "react-native";
import { Temporal } from "temporal-polyfill/full";
import { useFormatter, useTranslations } from "use-intl";

import { Text } from "@/components/ui/text";
import { ActionButton } from "@/features/dictation/action-button";
import { formatDuration } from "@/features/dictation/duration";
import { canApplyRecorderAction } from "@/features/dictation/recorder-state";
import type { NativeDraft } from "@/native/dictation-recorder";

export const DraftList = ({
  drafts,
  pending,
  onOpen,
  onFinish,
  onDelete,
}: {
  drafts: readonly NativeDraft[];
  pending: boolean;
  onOpen: (draft: NativeDraft) => void;
  onFinish: (draft: NativeDraft) => void;
  onDelete: (draft: NativeDraft) => void;
}) => {
  const t = useTranslations("dictation");
  const timers = useTranslations("timers");
  const format = useFormatter();
  return (
    <>
      {drafts.length === 0 ? null : (
        <Text variant="section">{t("drafts")}</Text>
      )}
      {drafts.map((draft) => (
        <View className="bg-card gap-3 rounded-xl p-4" key={draft.id}>
          <Text variant="rowTitle">
            {format.dateTime(
              Temporal.Instant.from(draft.createdAt).epochMilliseconds,
              { dateStyle: "medium", timeStyle: "short" },
            )}
          </Text>
          <Text variant="caption">
            {formatDuration(draft.elapsedMs, format)}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <ActionButton
              disabled={pending}
              label={draft.status === "paused" ? timers("resume") : t("open")}
              onPress={() => {
                onOpen(draft);
              }}
            />
            {draft.status === "paused" ? (
              <ActionButton
                disabled={pending}
                label={t("stop")}
                onPress={() => {
                  onFinish(draft);
                }}
              />
            ) : null}
            <ActionButton
              disabled={
                pending || !canApplyRecorderAction(draft.status, "delete")
              }
              label={t("delete")}
              onPress={() => {
                onDelete(draft);
              }}
            />
          </View>
        </View>
      ))}
    </>
  );
};
