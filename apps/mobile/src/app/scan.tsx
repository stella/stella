import { Suspense, useState, useTransition } from "react";

import { Result } from "better-result";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { useChanged } from "@/components/changes";
import { screenStyles } from "@/components/empty-state-screen";
import { MatterPicker } from "@/components/matter-picker";
import { Text, TextInput } from "@/components/ui/text";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { readFileProperty, uploadDocument } from "@/state/document-upload";
import { listMatters } from "@/state/matters";
import { useAppColors } from "@/theme";

/**
 * A scan the document camera saved, presented as a sheet: its name, how many
 * pages it has and the matter it goes into, already chosen when the scan
 * began inside one. Upload adds it to the matter as a PDF.
 */
const ScanScreen = () => {
  const { state } = useSession();
  return state.status === "signed-in" ? (
    <ScanForm source={state.source} />
  ) : null;
};

const ScanForm = ({ source }: { source: AccessTokenSource }) => {
  const t = useTranslations("scan");
  const tabs = useTranslations("tabs");
  const format = useFormatter();
  const colors = useAppColors();
  const router = useRouter();
  const { end } = useSession();
  const changed = useChanged();
  const params = useLocalSearchParams<{
    matterId?: string;
    pageCount: string;
    sha256Hex: string;
    size: string;
    uri: string;
  }>();
  const [name, setName] = useState(() =>
    t("defaultName", {
      day: format.dateTime(epochMilliseconds(), {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    }),
  );
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
  const ready = name.trim() !== "" && matterId !== null && !uploading;

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
            size: Number(params.size),
            uri: params.uri,
          },
          matterId,
          name: pdfName(name),
          propertyId,
          source,
        });
      });
      if (Result.isOk(uploaded)) {
        changed("documents");
        router.back();
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
          title: t("title"),
          unstable_headerLeftItems: () => [
            {
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
        className="bg-background flex-1"
        contentContainerStyle={screenStyles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <View className="gap-1">
          <TextInput
            accessibilityLabel={t("name")}
            onChangeText={setName}
            placeholder={t("name")}
            value={name}
          />
          <View className="px-1">
            <Text variant="caption">
              {t("pages", { count: Number(params.pageCount) })}
            </Text>
          </View>
        </View>
        {uploading ? <ActivityIndicator color={colors.muted} /> : null}
        <WriteFailureNotice failure={failure} message={t("uploadFailed")} />
        <View className="gap-2">
          <View className="px-1">
            <Text variant="section">{t("matterTitle")}</Text>
          </View>
          <Suspense fallback={<ActivityIndicator color={colors.muted} />}>
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

/** The file name the document is stored under: the name, as a PDF. */
function pdfName(name: string): string {
  const trimmed = name.trim();
  return trimmed.toLocaleLowerCase().endsWith(".pdf")
    ? trimmed
    : `${trimmed}.pdf`;
}

export default ScanScreen;
