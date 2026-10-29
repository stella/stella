import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useTranslations } from "use-intl";

import { useRevision } from "@/components/changes";
import { MatterEntities } from "@/components/matter-entities";
import { barGlyph } from "@/components/ui/bar-glyph";
import { useScan } from "@/components/use-scan";
import { useSession } from "@/connection/session-provider";
import { canScan } from "@/native/document-scanner";

/**
 * One matter, titled with the name its row carried so the header shows
 * before the load returns. Its "+" adds to it: a scanned document, where the
 * device has the document camera, or a task. Its list loads afresh after.
 */
const MatterScreen = () => {
  const { workspaceId, name } = useLocalSearchParams<{
    workspaceId: string;
    name?: string;
  }>();
  const { state } = useSession();
  const revision = useRevision("documents", "tasks");

  return (
    <>
      <Stack.Screen options={{ title: name ?? "" }} />
      <AddMenu workspaceId={workspaceId} />
      {state.status === "signed-in" ? (
        <MatterEntities
          key={revision}
          source={state.source}
          workspaceId={workspaceId}
        />
      ) : null}
    </>
  );
};

/** The matter's "+": a menu of what can be added to it. */
const AddMenu = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations("matter");
  const router = useRouter();
  const scan = useScan(workspaceId);

  return (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Menu>
        {barGlyph("plus")}
        <Stack.Toolbar.Label>{t("add")}</Stack.Toolbar.Label>
        {canScan() ? (
          <Stack.Toolbar.MenuAction onPress={scan}>
            {t("scanDocument")}
          </Stack.Toolbar.MenuAction>
        ) : null}
        <Stack.Toolbar.MenuAction
          onPress={() => {
            router.push({
              pathname: "/task/new",
              params: { matterId: workspaceId },
            });
          }}
        >
          {t("newTask")}
        </Stack.Toolbar.MenuAction>
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  );
};

export default MatterScreen;
