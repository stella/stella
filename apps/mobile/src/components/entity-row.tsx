import { Pressable } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { TASK_STATUS } from "@stll/api-contract/entity-options";
import type { TaskStatus } from "@stll/api-contract/entity-options";

import { Text } from "@/components/ui/text";
import { isKnownEntityKind } from "@/state/matter-entities";
import type { MatterEntity } from "@/state/matter-entities";

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
      className="border-border active:bg-accent gap-0.5 border-b py-3"
      onPress={onPress}
    >
      <Text numberOfLines={2} variant="rowTitle">
        {entity.name === null || entity.name === ""
          ? t("untitled")
          : entity.name}
      </Text>
      <Text numberOfLines={1} variant="caption">
        {details.join(" · ")}
      </Text>
    </Pressable>
  );
};
