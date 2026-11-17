import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useTranslations } from "use-intl";

import { MatterEntities } from "@/components/matter-entities";
import { MatterName } from "@/components/matter-name";
import { useCan } from "@/components/role";
import { barGlyph } from "@/components/ui/bar-glyph";
import { usePickDocument } from "@/components/use-pick-document";
import { useScan } from "@/components/use-scan";
import { useSession } from "@/connection/session-provider";
import { canScan } from "@/native/document-scanner";

/**
 * One matter, titled with its name: the one its row carried until the
 * matter is read, then the matter's own, which follows a rename made
 * anywhere in the app. Its "+" adds to it: a document from Files, a scanned
 * one where the device has the document camera, or a task. Its list loads
 * afresh after.
 */
const MatterScreen = () => {
  const { workspaceId, name } = useLocalSearchParams<{
    workspaceId: string;
    name?: string;
  }>();
  const { state } = useSession();

  return (
    <>
      <MatterName fallback={name ?? ""} matterId={workspaceId}>
        {(title) => <Stack.Screen options={{ title }} />}
      </MatterName>
      <AddMenu workspaceId={workspaceId} />
      {state.status === "signed-in" ? (
        <MatterEntities source={state.source} workspaceId={workspaceId} />
      ) : null}
    </>
  );
};

/**
 * The matter's Details, its own settings: name, number, client, team and
 * parties; and its "+", a menu of what the person's role may add to it,
 * left out when it may add nothing, as the web leaves out its own.
 */
const AddMenu = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations("matter");
  const router = useRouter();
  const scan = useScan(workspaceId);
  const pick = usePickDocument(workspaceId);
  const canAdd = useCan({ entity: ["create"] });

  return (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button
        onPress={() => {
          router.push({
            pathname: "/matter/[workspaceId]/tasks",
            params: { workspaceId },
          });
        }}
      >
        {barGlyph("list-todo")}
        <Stack.Toolbar.Label>{t("tasks")}</Stack.Toolbar.Label>
      </Stack.Toolbar.Button>
      <Stack.Toolbar.Button
        onPress={() => {
          router.push({
            pathname: "/matter/[workspaceId]/info",
            params: { workspaceId },
          });
        }}
      >
        <Stack.Toolbar.Label>{t("details")}</Stack.Toolbar.Label>
      </Stack.Toolbar.Button>
      {canAdd ? (
        <Stack.Toolbar.Menu>
          {barGlyph("plus")}
          <Stack.Toolbar.Label>{t("add")}</Stack.Toolbar.Label>
          <Stack.Toolbar.MenuAction onPress={pick}>
            {t("uploadDocument")}
          </Stack.Toolbar.MenuAction>
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
      ) : null}
    </Stack.Toolbar>
  );
};

export default MatterScreen;
