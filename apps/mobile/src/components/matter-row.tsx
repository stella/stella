import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { useFormatter } from "use-intl";

import { MatterIcon } from "@/components/ui/matter-icon";
import { Text } from "@/components/ui/text";
import type { MatterSummary } from "@/state/matters";

/**
 * One matter: its name, then reference, client and the day of its last
 * activity. The day is a date, not "2 days ago": Hermes, the app's
 * JavaScript engine, cannot format relative times. Tapping it opens the
 * matter.
 */
export const MatterRow = ({ matter }: { matter: MatterSummary }) => {
  const format = useFormatter();
  const router = useRouter();
  const activity =
    matter.lastActivityAt === null || matter.lastActivityAt === undefined
      ? undefined
      : format.dateTime(new Date(matter.lastActivityAt), {
          day: "numeric",
          month: "short",
        });
  const details = [
    matter.reference,
    matter.client?.displayName,
    activity,
  ].filter(
    (detail): detail is string =>
      detail !== undefined && detail !== null && detail !== "",
  );

  return (
    <Pressable
      accessibilityRole="button"
      className="border-border active:bg-accent flex-row gap-3 border-b py-3"
      onPress={() => {
        router.push({
          pathname: "/matter/[workspaceId]",
          params: { workspaceId: matter.id, name: matter.name },
        });
      }}
    >
      <View className="pt-0.5">
        <MatterIcon matter={matter} size={18} />
      </View>
      <View className="flex-1 gap-0.5">
        <Text numberOfLines={2} variant="rowTitle">
          {matter.name}
        </Text>
        {details.length === 0 ? null : (
          <Text numberOfLines={1} variant="caption">
            {details.join(" · ")}
          </Text>
        )}
      </View>
    </Pressable>
  );
};
