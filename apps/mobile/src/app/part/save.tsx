import { Suspense, useRef, useState, useTransition } from "react";

import { Result } from "better-result";
import {
  Stack,
  useLocalSearchParams,
  useNavigation,
  usePreventRemove,
  useRouter,
} from "expo-router";
import { ScrollView, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { formatFileSize } from "@stll/ui/file-size";
import { Loader } from "@stll/ui/loader";
import { Text } from "@stll/ui/text";

import { useChanged } from "@/components/changes";
import { screenStyles } from "@/components/empty-state-screen";
import { MatterPicker } from "@/components/matter-picker";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { saveDocumentPart } from "@/state/document-file";
import { listMatters } from "@/state/matters";

/**
 * One part of a document's file (an attachment, a file in an archive, a
 * mailbox's message) on its way into a matter as a document of its own: its
 * name and size, and the matter it goes into, the document's own at first.
 * The sheet stays open until the part is saved.
 */
const SavePartScreen = () => {
  const { state } = useSession();
  return state.status === "signed-in" ? (
    <SavePartForm source={state.source} />
  ) : null;
};

const SavePartForm = ({ source }: { source: AccessTokenSource }) => {
  const t = useTranslations("fileParts");
  const scan = useTranslations("scan");
  const tabs = useTranslations("tabs");
  const format = useFormatter();
  const router = useRouter();
  const navigation = useNavigation();
  const { end } = useSession();
  const changed = useChanged();
  const params = useLocalSearchParams<{
    workspaceId: string;
    fieldId: string;
    part: string;
    name: string;
    size: string;
  }>();
  const size = parseIntegerToken(params.size, { sign: "unsigned" }).unwrapOr(0);
  const [matterId, setMatterId] = useState<string | null>(params.workspaceId);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [saving, startSaving] = useTransition();
  // A save in progress keeps the sheet up, Escape included, so a failure can
  // still show for a retry; only the save's own success closes it then.
  const saved = useRef(false);
  usePreventRemove(saving, ({ repeat }) => {
    if (saved.current) {
      repeat();
    }
  });
  const [matters] = useState(async () => {
    const result = await listMatters({ fetch, source });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end(source);
    }
    return result;
  });
  const ready = matterId !== null && !saving;

  const save = () => {
    if (matterId === null) {
      return;
    }
    startSaving(async () => {
      setFailure(null);
      const stored = await saveDocumentPart({
        fetch,
        source,
        workspaceId: params.workspaceId,
        fieldId: params.fieldId,
        part: params.part,
        destinationWorkspaceId: matterId,
      });
      if (Result.isOk(stored)) {
        changed("documents");
        if (navigation.isFocused()) {
          saved.current = true;
          router.back();
        }
        return;
      }
      if (stored.error._tag === "SignedOutError") {
        end(source);
        return;
      }
      setFailure(writeFailure(stored.error));
    });
  };

  return (
    <>
      <Stack.Screen
        options={{
          // A save in progress keeps the sheet up until it is done.
          gestureEnabled: !saving,
          title: scan("saveTitle"),
          unstable_headerLeftItems: () => [
            {
              disabled: saving,
              label: tabs("close"),
              onPress: () => {
                router.back();
              },
              type: "button",
            },
          ],
          unstable_headerRightItems: () => [
            {
              disabled: !ready,
              label: scan("save"),
              onPress: save,
              type: "button",
              variant: "done",
            },
          ],
        }}
      />
      <ScrollView
        alwaysBounceVertical={false}
        className="bg-background flex-1"
        contentContainerStyle={screenStyles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <View className="gap-1 px-1">
          <Text numberOfLines={2} variant="rowTitle">
            {params.name || t("unnamed")}
          </Text>
          <Text variant="caption">{formatFileSize(size, format)}</Text>
        </View>
        {saving ? <Loader /> : null}
        <WriteFailureNotice failure={failure} message={t("saveFailed")} />
        <View className="gap-2">
          <View className="px-1">
            <Text variant="section">{scan("matterTitle")}</Text>
          </View>
          <Suspense fallback={<Loader />}>
            <MatterPicker
              matters={matters}
              onSelect={setMatterId}
              selected={matterId}
            />
          </Suspense>
        </View>
      </ScrollView>
    </>
  );
};

export default SavePartScreen;
