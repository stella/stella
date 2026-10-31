import { Suspense, useState, useTransition } from "react";

import { Result } from "better-result";
import {
  Stack,
  useLocalSearchParams,
  useNavigation,
  useRouter,
} from "expo-router";
import { ScrollView, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { Loader } from "@stll/ui/loader";
import { Text } from "@stll/ui/text";

import { useChanged } from "@/components/changes";
import { screenStyles } from "@/components/empty-state-screen";
import { MatterPicker } from "@/components/matter-picker";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { readFileProperty, uploadDocument } from "@/state/document-upload";
import { listMatters } from "@/state/matters";
import { sizeInUnits } from "@/state/scan-pages";

/**
 * The reviewed scan, bound into a PDF, on its way into a matter: its name,
 * pages and size, and the matter it goes into, already chosen when the scan
 * began inside one. Upload adds it to the matter and closes the review too;
 * the sheet stays open until the upload is done.
 */
const SaveScanScreen = () => {
  const { state } = useSession();
  return state.status === "signed-in" ? (
    <SaveScanForm source={state.source} />
  ) : null;
};

const SaveScanForm = ({ source }: { source: AccessTokenSource }) => {
  const t = useTranslations("scan");
  const tabs = useTranslations("tabs");
  const format = useFormatter();
  const router = useRouter();
  const navigation = useNavigation();
  const { end } = useSession();
  const changed = useChanged();
  const params = useLocalSearchParams<{
    matterId?: string;
    name: string;
    pageCount: string;
    sha256Hex: string;
    size: string;
    uri: string;
  }>();
  // The review passes both counts; a missing one reads as none.
  const size = parseIntegerToken(params.size, { sign: "unsigned" }).unwrapOr(0);
  const pageCount = parseIntegerToken(params.pageCount, {
    sign: "unsigned",
  }).unwrapOr(0);
  const sizeLabel = sizeInUnits(size);
  const [matterId, setMatterId] = useState(params.matterId ?? null);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [uploading, startUploading] = useTransition();
  const [matters] = useState(async () => {
    const result = await listMatters({ fetch, source });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end(source);
    }
    return result;
  });
  const ready = matterId !== null && !uploading;

  const upload = () => {
    if (matterId === null) {
      return;
    }
    startUploading(async () => {
      setFailure(null);
      const uploaded = await Result.gen(async function* () {
        const propertyId = yield* Result.await(
          readFileProperty({ fetch, matterId, source }),
        );
        return await uploadDocument({
          fetch,
          file: {
            mimeType: "application/pdf",
            sha256Hex: params.sha256Hex,
            size,
            uri: params.uri,
          },
          matterId,
          name: params.name,
          propertyId,
          source,
        });
      });
      if (Result.isOk(uploaded)) {
        changed("documents");
        // This sheet and the review under it, which removes the scan's files
        // as it closes. A sheet closed meanwhile, as Escape can, leaves the
        // review as it is.
        if (navigation.isFocused()) {
          router.dismiss(2);
        }
        return;
      }
      if (uploaded.error._tag === "SignedOutError") {
        end(source);
        return;
      }
      setFailure(writeFailure(uploaded.error));
    });
  };

  return (
    <>
      <Stack.Screen
        options={{
          // An upload in progress keeps the sheet up until it is done.
          gestureEnabled: !uploading,
          title: t("saveTitle"),
          unstable_headerLeftItems: () => [
            {
              disabled: uploading,
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
              label: t("upload"),
              onPress: upload,
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
            {params.name}
          </Text>
          <Text variant="caption">
            {[
              t("pages", { count: pageCount }),
              t(sizeLabel.unit, { size: format.number(sizeLabel.value) }),
            ].join(" · ")}
          </Text>
        </View>
        {uploading ? <Loader /> : null}
        <WriteFailureNotice failure={failure} message={t("uploadFailed")} />
        <View className="gap-2">
          <View className="px-1">
            <Text variant="section">{t("matterTitle")}</Text>
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

export default SaveScanScreen;
