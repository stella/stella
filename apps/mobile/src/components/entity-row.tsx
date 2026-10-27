import { Pressable, StyleSheet, Text, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { TASK_STATUS } from "@stll/api-contract/entity-options";
import type { TaskStatus } from "@stll/api-contract/entity-options";

import { isKnownEntityKind } from "@/state/matter-entities";
import type { MatterEntity } from "@/state/matter-entities";
import { useAppColors } from "@/theme";

const TASK_STATUSES: ReadonlySet<string> = new Set(Object.values(TASK_STATUS));

const isTaskStatus = (status: string): status is TaskStatus =>
  TASK_STATUSES.has(status);

/**
 * One document, folder or task: its name, then its kind (or a task's
 * status) and the day it last changed. A date, not "2 days ago": Hermes,
 * the app's JavaScript engine, cannot format relative times.
 */
export const EntityRow = ({
  entity,
  onPress,
}: {
  entity: MatterEntity;
  onPress: () => void;
}) => {
  const t = useTranslations("matter");
  const colors = useAppColors();
  const format = useFormatter();
  const changedAt = entity.updatedAt ?? entity.createdAt;
  const label = (() => {
    const { kind, status } = entity;
    if (kind === "task" && typeof status === "string" && isTaskStatus(status)) {
      return t(`status.${status}`);
    }
    return isKnownEntityKind(kind) ? t(`kind.${kind}`) : undefined;
  })();
  const details = [
    label,
    t("updated", {
      time: format.dateTime(new Date(changedAt), {
        day: "numeric",
        month: "short",
      }),
    }),
  ].filter((detail): detail is string => detail !== undefined);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <View
        style={[
          styles.marker,
          {
            backgroundColor:
              entity.kind === "folder" ? colors.muted : colors.accent,
          },
        ]}
      />
      <View style={styles.text}>
        <Text numberOfLines={2} style={[styles.name, { color: colors.text }]}>
          {entity.name === null || entity.name === ""
            ? t("untitled")
            : entity.name}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.details, { color: colors.muted }]}
        >
          {details.join(" · ")}
        </Text>
      </View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  details: {
    fontSize: 13,
  },
  marker: {
    borderRadius: 3,
    height: 28,
    width: 6,
  },
  name: {
    fontSize: 16,
    fontWeight: "600",
  },
  row: {
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    marginBottom: 8,
    minHeight: 56,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  text: {
    flex: 1,
    gap: 2,
  },
});
