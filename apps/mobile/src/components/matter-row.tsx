import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { useFormatter } from "use-intl";

import { useLayout, useSelection } from "@/components/selection";
import { MatterIcon } from "@/components/ui/matter-icon";
import { Text } from "@/components/ui/text";
import type { MatterSummary } from "@/state/matters";

/**
 * One matter: its name, then reference, client and the day of its last
 * activity. The day is a date, not "2 days ago": Hermes, the app's
 * JavaScript engine, cannot format relative times. Under its client's
 * heading the client goes unsaid. Tapping it opens the matter, beside the
 * list where the window has two columns, which marks it as the one open.
 */
export const MatterRow = ({
  matter,
  underClient = false,
}: {
  matter: MatterSummary;
  underClient?: boolean;
}) => {
  const format = useFormatter();
  const router = useRouter();
  const layout = useLayout();
  const selection = useSelection();
  const open =
    layout.usesSplitView && selection.matter?.workspaceId === matter.id;
  const activity =
    matter.lastActivityAt === null || matter.lastActivityAt === undefined
      ? undefined
      : format.dateTime(new Date(matter.lastActivityAt), {
          day: "numeric",
          month: "short",
        });
  const details = [
    matter.reference,
    underClient ? undefined : matter.client?.displayName,
    activity,
  ].filter(
    (detail): detail is string =>
      detail !== undefined && detail !== null && detail !== "",
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: open }}
      className={`border-border active:bg-accent flex-row gap-3 border-b py-3 ${open ? "bg-accent" : ""}`}
      onPress={() => {
        if (layout.usesSplitView) {
          selection.select("matter", {
            name: matter.name,
            workspaceId: matter.id,
          });
          return;
        }
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
