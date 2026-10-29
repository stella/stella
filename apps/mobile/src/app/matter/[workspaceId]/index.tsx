import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import type { NativeStackHeaderItem } from "expo-router/native-stack";
import { useTranslations } from "use-intl";

import { useRevision } from "@/components/changes";
import { MatterEntities } from "@/components/matter-entities";
import { useGlyphImage } from "@/components/ui/use-glyph-image";
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
  const addItems = useAddItems(workspaceId);

  return (
    <>
      <Stack.Screen
        options={{
          title: name ?? "",
          unstable_headerRightItems: () => addItems,
        }}
      />
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
function useAddItems(workspaceId: string): NativeStackHeaderItem[] {
  const t = useTranslations("matter");
  const router = useRouter();
  const scan = useScan(workspaceId);
  const plusGlyph = useGlyphImage("plus");

  if (plusGlyph === null) {
    return [];
  }
  return [
    {
      icon: { source: plusGlyph, type: "image" },
      label: t("add"),
      menu: {
        items: [
          ...(canScan()
            ? [
                {
                  label: t("scanDocument"),
                  onPress: scan,
                  type: "action" as const,
                },
              ]
            : []),
          {
            label: t("newTask"),
            onPress: () => {
              router.push({
                pathname: "/task/new",
                params: { matterId: workspaceId },
              });
            },
            type: "action",
          },
        ],
      },
      type: "menu",
    },
  ];
}

export default MatterScreen;
