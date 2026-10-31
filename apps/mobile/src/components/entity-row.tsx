import { Pressable, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { TASK_STATUS } from "@stll/api-contract/entity-options";
import type { TaskStatus } from "@stll/api-contract/entity-options";
import { Text } from "@stll/ui/text";

import { EntityKindIcon } from "@/components/entity-kind-icon";
import { ChevronDownIcon, ChevronRightIcon } from "@/icons.gen";
import { isKnownEntityKind } from "@/state/matter-entities";
import type { MatterEntity } from "@/state/matter-entities";
import { useUiColors } from "@/theme";

const TASK_STATUSES: ReadonlySet<string> = new Set(Object.values(TASK_STATUS));

const isTaskStatus = (status: string): status is TaskStatus =>
  TASK_STATUSES.has(status);

/** How far each folder level indents its contents. */
const DEPTH_INDENT = 20;

/**
 * One document, folder or task: its name, then its kind (or a task's
 * status) and the day it last changed. A date, not "2 days ago": Hermes,
 * the app's JavaScript engine, cannot format relative times. A row inside
 * folders is indented by its depth; a folder shows whether it is open.
 */
export const EntityRow = ({
  depth,
  entity,
  folder,
  onPress,
}: {
  depth: number;
  entity: MatterEntity;
  folder: { open: boolean } | null;
  onPress: () => void;
}) => {
  const t = useTranslations("matter");
  const ui = useUiColors();
  const format = useFormatter();
  const changedAt = entity.updatedAt ?? entity.createdAt;
  const label = (() => {
    const { kind, status } = entity;
    if (kind === "task" && typeof status === "string" && isTaskStatus(status)) {
      return t(`status.${status}`);
    }
    // A document names its file's format ("PDF", "DOCX") rather than its kind.
    if (entity.fileType !== undefined) {
      return entity.fileType;
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
      accessibilityState={
        folder === null ? undefined : { expanded: folder.open }
      }
      className="border-border active:bg-accent flex-row gap-3 border-b py-3"
      onPress={onPress}
      style={{ paddingStart: depth * DEPTH_INDENT }}
    >
      <View className="pt-0.5">
        <EntityKindIcon color={ui.mutedForeground} kind={entity.kind} />
      </View>
      <View className="flex-1 gap-0.5">
        <Text numberOfLines={2} variant="rowTitle">
          {entity.name === null || entity.name === ""
            ? t("untitled")
            : entity.name}
        </Text>
        <Text numberOfLines={1} variant="caption">
          {details.join(" · ")}
        </Text>
      </View>
      {folder === null ? null : (
        <View className="self-center">
          {folder.open ? (
            <ChevronDownIcon color={ui.mutedForeground} size={16} />
          ) : (
            <ChevronRightIcon color={ui.mutedForeground} size={16} />
          )}
        </View>
      )}
    </Pressable>
  );
};
