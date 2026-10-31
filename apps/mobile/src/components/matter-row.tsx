import { Link, useRouter } from "expo-router";
import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { MatterIcon } from "@stll/ui/matter-icon";
import { Text } from "@stll/ui/text";

import { useLayout, useSelection } from "@/components/selection";
import { useScan } from "@/components/use-scan";
import { canScan } from "@/native/document-scanner";
import type { MatterSummary } from "@/state/matters";

/**
 * One matter: its name, then reference, client and the day of its last
 * activity. The day is a date, not "2 days ago": Hermes, the app's
 * JavaScript engine, cannot format relative times. Under its client's
 * heading the client goes unsaid. Tapping it opens the matter, beside the
 * list where the window has two columns, which marks it as the one open.
 * Holding it adds to it without opening it: a task, or a scanned document
 * where the device can scan.
 */
export const MatterRow = ({
  matter,
  underClient = false,
}: {
  matter: MatterSummary;
  underClient?: boolean;
}) => {
  const format = useFormatter();
  const t = useTranslations("matter");
  const router = useRouter();
  const scan = useScan(matter.id);
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
    <Link
      asChild
      href={{
        pathname: "/matter/[workspaceId]",
        params: { workspaceId: matter.id, name: matter.name },
      }}
      onPress={(event) => {
        if (layout.usesSplitView) {
          event.preventDefault();
          selection.select("matter", {
            name: matter.name,
            workspaceId: matter.id,
          });
        }
      }}
    >
      <Link.Trigger>
        <Button
          accessibilityState={{ selected: open }}
          size="row"
          variant="ghost"
        >
          <View className="border-border flex-1 flex-row gap-3 border-b py-3">
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
          </View>
        </Button>
      </Link.Trigger>
      <Link.Menu>
        <Link.MenuAction
          icon="checklist"
          onPress={() => {
            router.push({
              pathname: "/task/new",
              params: { matterId: matter.id },
            });
          }}
        >
          {t("newTask")}
        </Link.MenuAction>
        <Link.MenuAction
          hidden={!canScan()}
          icon="doc.viewfinder"
          onPress={scan}
        >
          {t("scanDocument")}
        </Link.MenuAction>
      </Link.Menu>
    </Link>
  );
};
