import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { Result } from "better-result";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocale, useTranslations } from "use-intl";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import { Loader } from "@stll/ui/loader";
import { Text } from "@stll/ui/text";

import DocumentView from "@/components/document-viewer/document-view.dom";
import { FIT_ZOOM, pageAppearance } from "@/components/document-viewer/zoom";
import type { ViewerAppearance } from "@/components/document-viewer/zoom";
import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { LegalFilePreviewText } from "@/components/legal-file-preview-text";
import { LucideGlyphs } from "@/components/ui/lucide-glyphs";
import { useDocumentEditing } from "@/components/use-document-editing";
import {
  viewerBarClearance,
  ViewerControls,
} from "@/components/viewer-controls";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import {
  canOpenFiles,
  discardOpenedFile,
  downloadDocument,
  previewOpenedFile,
  readOpenedFile,
} from "@/native/document-files";
import type { OpenedFile } from "@/native/document-files";
import {
  isOffline,
  readDocumentFile,
  readOriginalDocumentFile,
} from "@/state/document-file";
import type { DocumentFile, LegalDocumentFile } from "@/state/document-file";
import { useAppColors } from "@/theme";

type Failure = "offline" | "noFile" | "failed" | "unsupported" | "android";

type Phase =
  | { readonly status: "opening" }
  | { readonly status: "failed"; readonly failure: Failure }
  | {
      readonly status: "legalPreview";
      readonly file: LegalDocumentFile;
    }
  | {
      readonly status: "open";
      readonly file: Exclude<DocumentFile, LegalDocumentFile>;
      readonly opened: OpenedFile;
      /** The viewer could not draw it; Quick Look may still show it. */
      readonly unrendered: boolean;
    };

/** Finds the current file, then downloads it to the phone for a viewer. */
const openDocument = async ({
  source,
  workspaceId,
  entityId,
}: {
  source: AccessTokenSource;
  workspaceId: string;
  entityId: string;
}): Promise<Phase> => {
  const file = await readDocumentFile({ fetch, source, workspaceId, entityId });
  if (Result.isError(file)) {
    if (file.error._tag === "NoFileError") {
      return { status: "failed", failure: "noFile" };
    }
    return {
      status: "failed",
      failure: isOffline(file.error) ? "offline" : "failed",
    };
  }
  if (
    file.value.viewer === "asic" ||
    file.value.viewer === "signed-dossier" ||
    file.value.viewer === "cades" ||
    file.value.viewer === "dataBox" ||
    file.value.viewer === "structured-document"
  ) {
    return { status: "legalPreview", file: file.value };
  }
  if (!canOpenFiles()) {
    // An older iPhone build gains the viewer by updating; Android has none.
    return {
      status: "failed",
      failure: Platform.OS === "android" ? "android" : "unsupported",
    };
  }
  const opened = await downloadDocument(file.value.url, file.value.fileName);
  if (Result.isError(opened)) {
    return {
      status: "failed",
      failure: opened.error.offline ? "offline" : "failed",
    };
  }
  return {
    status: "open",
    file: file.value,
    opened: opened.value,
    unrendered: false,
  };
};

/** Never settles: what the viewer gets once this screen has gone. */
const UNANSWERED = new Promise<never>(() => {
  // The web view that asked is gone; an answer sent to it would throw.
});

/**
 * One document of a matter, opened from its row. A Word document is laid out
 * by folio, a PDF drawn by pdf.js, and a data box export shown as source
 * text. Other files open in Quick Look. Downloaded files are temporary.
 */
const DocumentScreen = () => {
  const { workspaceId, entityId, name } = useLocalSearchParams<{
    workspaceId: string;
    entityId: string;
    name?: string;
  }>();
  const [attempt, setAttempt] = useState(0);
  return (
    <OpenedDocument
      entityId={entityId}
      key={attempt}
      name={name}
      onRetry={() => {
        setAttempt((count) => count + 1);
      }}
      workspaceId={workspaceId}
    />
  );
};

const OpenedDocument = ({
  workspaceId,
  entityId,
  name,
  onRetry,
}: {
  workspaceId: string;
  entityId: string;
  name: string | undefined;
  onRetry: () => void;
}) => {
  const colors = useAppColors();
  const scheme = useColorScheme();
  const t = useTranslations("document");
  const locale = useLocale();
  const router = useRouter();
  const { state } = useSession();
  const source = state.status === "signed-in" ? state.source : null;
  const [phase, setPhase] = useState<Phase>({ status: "opening" });
  const [ready, setReady] = useState(false);
  const insets = useSafeAreaInsets();
  const [zoom, setZoom] = useState(FIT_ZOOM);
  const [appearance, setAppearance] = useState<ViewerAppearance>("system");
  // The viewer's web view may still ask for bytes, or be answered, after this
  // screen has gone; an answer sent to a removed web view throws, so none is.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (source === null) {
      return undefined;
    }
    let current = true;
    let opened: OpenedFile | null = null;
    const open = async () => {
      const next = await openDocument({ source, workspaceId, entityId });
      if (next.status === "open") {
        opened = next.opened;
      }
      if (current) {
        setPhase(next);
      } else if (opened !== null) {
        discardOpenedFile(opened);
      }
    };
    void open();
    return () => {
      current = false;
      if (opened !== null) {
        discardOpenedFile(opened);
      }
    };
  }, [source, workspaceId, entityId]);

  const showPreview = async (opened: OpenedFile) => {
    const shown = await previewOpenedFile(opened);
    // A preview already open is the one asked for.
    if (Result.isError(shown) && !shown.error.busy && mounted.current) {
      Alert.alert(t("failedTitle"), t("failure.failed"));
    }
  };
  const preview = useEffectEvent(showPreview);

  // Any other file opens in Quick Look straight away; closing it returns here,
  // where it can be opened again.
  const quickLook =
    phase.status === "open" && phase.file.viewer === "quick-look"
      ? phase.opened
      : null;
  useEffect(() => {
    if (quickLook !== null) {
      void preview(quickLook);
    }
  }, [quickLook]);

  // A Word document is editable from the start; the first tap into its
  // text opens it for editing.
  const editableProperty =
    phase.status === "open" && phase.file.viewer === "docx"
      ? phase.file.propertyId
      : null;
  const target = useMemo(
    () =>
      editableProperty === null
        ? null
        : { workspaceId, entityId, propertyId: editableProperty },
    [workspaceId, entityId, editableProperty],
  );
  const editing = useDocumentEditing({
    source,
    target,
    viewedVersion: phase.status === "open" ? phase.file.versionNumber : null,
    // The edit is the document's new version: open it afresh.
    onFinished: onRetry,
  });
  const editingFile =
    editing.phase.status === "editing" || editing.phase.status === "finishing"
      ? editing.phase.file
      : null;

  const title =
    phase.status === "open" || phase.status === "legalPreview"
      ? phase.file.fileName
      : (name ?? t("title"));

  const body = (() => {
    if (source === null || phase.status === "opening") {
      return <Loader style={styles.center} />;
    }
    if (phase.status === "failed") {
      return (
        <View style={screenStyles.content}>
          <EmptyCard
            description={t(`failure.${phase.failure}`)}
            title={t("failedTitle")}
          >
            {phase.failure === "noFile" ||
            phase.failure === "unsupported" ||
            phase.failure === "android" ? null : (
              <Button className="mt-4" onPress={onRetry} variant="outline">
                {t("retry")}
              </Button>
            )}
          </EmptyCard>
        </View>
      );
    }
    if (phase.status === "legalPreview") {
      return (
        <LegalFilePreview
          file={phase.file}
          key={phase.file.fieldId}
          onRetry={onRetry}
          showPreview={showPreview}
          source={source}
          workspaceId={workspaceId}
        />
      );
    }
    const { file } = phase;
    // While editing, the viewer shows the working copy the edit started from.
    const opened = editingFile ?? phase.opened;
    if (file.viewer === "quick-look" || phase.unrendered) {
      return (
        <View style={screenStyles.content}>
          <EmptyCard
            description={
              phase.unrendered ? t("unrendered") : t("previewDescription")
            }
            title={file.fileName}
          >
            <Button
              className="mt-4"
              onPress={() => {
                void showPreview(opened);
              }}
              variant="outline"
            >
              {t("preview")}
            </Button>
          </EmptyCard>
        </View>
      );
    }
    return (
      <View style={screenStyles.screen}>
        <DocumentView
          appearance={pageAppearance(
            appearance,
            scheme === "dark" ? "dark" : "light",
          )}
          dom={{ style: { flex: 1 } }}
          editable={editing.canEdit}
          // A new file, or a reload that drops what was typed, remounts it.
          fileName={file.fileName}
          key={`${opened.uri}#${String(editing.revision)}`}
          kind={file.viewer}
          locale={locale}
          onFailed={() => {
            if (mounted.current) {
              setPhase({ ...phase, unrendered: true });
            }
          }}
          onEditRequest={() => {
            if (mounted.current) {
              editing.requestEdit();
            }
          }}
          onEditSaved={async (size: number | null, final: boolean) =>
            mounted.current ? await editing.editSaved(size, final) : false
          }
          onReady={() => {
            if (mounted.current) {
              setReady(true);
              editing.viewerReady();
            }
          }}
          readChunk={async (offset: number, length: number) => {
            const slice = await readOpenedFile(opened, offset, length);
            return mounted.current ? slice : await UNANSWERED;
          }}
          clearance={viewerBarClearance(insets.bottom)}
          saveRequest={editing.saveRequest}
          size={opened.size}
          writeEdit={(offset: number, base64: string) => {
            if (mounted.current) {
              editing.writeEdit(offset, base64);
            }
          }}
          zoom={zoom}
        />
        {ready ? (
          <ViewerControls
            appearance={appearance}
            onAppearance={setAppearance}
            onZoom={setZoom}
            zoom={zoom}
          />
        ) : (
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              styles.center,
              { backgroundColor: colors.background },
            ]}
          >
            <Loader />
          </View>
        )}
      </View>
    );
  })();

  return (
    <View style={[screenStyles.screen, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          headerRight: () =>
            editing.phase.status === "viewing" ? (
              <Button
                accessibilityLabel={t("details")}
                hitSlop={8}
                onPress={() => {
                  router.push({
                    pathname: "/matter/[workspaceId]/[entityId]",
                    params: { workspaceId, entityId },
                  });
                }}
                size="icon-sm"
                variant="ghost"
              >
                <LucideGlyphs color={colors.text} name="info" size={22} />
              </Button>
            ) : (
              <EditingStatus
                onDone={editing.requestFinish}
                phase={editing.phase.status}
                saveState={editing.saveState}
              />
            ),
          title,
        }}
      />
      {body}
    </View>
  );
};

const LegalFilePreview = ({
  file,
  onRetry,
  showPreview,
  source,
  workspaceId,
}: {
  file: LegalDocumentFile;
  onRetry: () => void;
  showPreview: (file: OpenedFile) => Promise<void>;
  source: AccessTokenSource;
  workspaceId: string;
}) => {
  const t = useTranslations("document");
  const common = useTranslations("common");
  const signedFile = useTranslations("signedFile");
  const structuredDocument = useTranslations("structuredDocument");
  const { fieldId, preview, viewer } = file;
  const [openingOriginal, setOpeningOriginal] = useState(false);
  const originalInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Each await can outlive the screen; read the ref afresh after every one.
  const isMounted = () => mounted.current;
  const openOriginal = async () => {
    if (originalInFlight.current) {
      return;
    }
    originalInFlight.current = true;
    setOpeningOriginal(true);
    let opened: OpenedFile | null = null;
    try {
      const original = await readOriginalDocumentFile({
        fetch,
        source,
        workspaceId,
        fieldId,
      });
      if (!isMounted()) {
        return;
      }
      if (Result.isError(original)) {
        Alert.alert(
          t("failedTitle"),
          t(isOffline(original.error) ? "failure.offline" : "failure.failed"),
        );
        return;
      }
      const downloaded = await downloadDocument(
        original.value.presignedUrl,
        original.value.fileName,
      );
      if (Result.isOk(downloaded)) {
        opened = downloaded.value;
        if (isMounted()) {
          await showPreview(opened);
        }
      } else if (isMounted()) {
        Alert.alert(
          t("failedTitle"),
          t(downloaded.error.offline ? "failure.offline" : "failure.failed"),
        );
      }
    } finally {
      if (opened !== null) {
        discardOpenedFile(opened);
      }
      originalInFlight.current = false;
      if (isMounted()) {
        setOpeningOriginal(false);
      }
    }
  };

  const previewBody = (() => {
    if (viewer === "cades" && Result.isOk(preview)) {
      const { fileName, layers, text, textFormat } = preview.value;
      return (
        <>
          <Text accessibilityRole="header" selectable variant="headline">
            {fileName}
          </Text>
          <Text variant="caption">{signedFile("unverified")}</Text>
          {layers.map(({ id, signers }, index) => (
            <View key={id}>
              <Text accessibilityRole="header" variant="label">
                {signedFile("layer", { number: index + 1 })}
              </Text>
              {signers.map((signer) => (
                <Text key={signer.id} selectable>
                  {signer.name ?? signedFile("unknownSigner")}
                </Text>
              ))}
            </View>
          ))}
          {text.trim() ? (
            <LegalFilePreviewText format={textFormat} text={text} />
          ) : (
            <Text variant="caption">{signedFile("noReadableContent")}</Text>
          )}
        </>
      );
    }
    if (preview.status === "ok") {
      if (viewer === "asic") {
        return (
          <>
            <Text variant="caption">{signedFile("unverified")}</Text>
            {preview.value.members.map(
              ({ fileName, status, text, textFormat }) => (
                <View key={fileName}>
                  <Text accessibilityRole="header" selectable variant="label">
                    {fileName}
                  </Text>
                  {status !== "unavailable" && text.trim() ? (
                    <LegalFilePreviewText format={textFormat} text={text} />
                  ) : null}
                  {status === "truncated" && (
                    <Text variant="caption">{common("previewTruncated")}</Text>
                  )}
                  {status === "unavailable" && (
                    <Text variant="caption">
                      {signedFile("noReadableContent")}
                    </Text>
                  )}
                </View>
              ),
            )}
          </>
        );
      }
      if (viewer === "signed-dossier") {
        const { documents, signers } = preview.value;
        return (
          <>
            {preview.value.receipt && (
              <Text accessibilityRole="header" variant="headline">
                {signedFile("deliveryReceipt")}
              </Text>
            )}
            <Text variant="caption">{signedFile("unverified")}</Text>
            <View>
              <Text accessibilityRole="header" variant="label">
                {signedFile("signers")}
              </Text>
              {signers.length === 0 ? (
                <Text variant="caption">{signedFile("noSigners")}</Text>
              ) : (
                signers.map((signer) => (
                  <Text key={signer.id} selectable>
                    {signer.name ?? signedFile("unknownSigner")}
                  </Text>
                ))
              )}
            </View>
            {documents.map(({ id, fileName, status, text, textFormat }) => (
              <View key={id}>
                <Text accessibilityRole="header" selectable variant="label">
                  {fileName}
                </Text>
                {status !== "unavailable" && text.trim() ? (
                  <LegalFilePreviewText format={textFormat} text={text} />
                ) : null}
                {status === "truncated" && (
                  <Text variant="caption">{common("previewTruncated")}</Text>
                )}
                {status === "unavailable" && (
                  <Text variant="caption">
                    {signedFile("noReadableContent")}
                  </Text>
                )}
              </View>
            ))}
          </>
        );
      }
      if (viewer === "structured-document") {
        return (
          <>
            <Text variant="caption">{structuredDocument("textOnly")}</Text>
            <LegalFilePreviewText format="plain" text={preview.value.text} />
            {preview.value.truncated && (
              <Text variant="caption">{common("previewTruncated")}</Text>
            )}
          </>
        );
      }
      return <Text selectable>{preview.value.text}</Text>;
    }
    const { error } = preview;
    const unreadable =
      error._tag === "ApiRequestError" &&
      error.code === PREVIEW_UNAVAILABLE_ERROR_CODE;
    const requestFailure = isOffline(error)
      ? "failure.offline"
      : "failure.failed";
    const unreadableMessages = {
      dataBox: t("failure.dataBoxUnreadable"),
      "structured-document": structuredDocument("noReadableContent"),
      asic: signedFile("unreadable"),
      cades: signedFile("unreadable"),
      "signed-dossier": signedFile("unreadable"),
    } satisfies Record<typeof viewer, string>;
    const unreadableMessage = unreadableMessages[viewer];
    return (
      <EmptyCard
        description={unreadable ? unreadableMessage : t(requestFailure)}
        title={t("failedTitle")}
      >
        {unreadable ? null : (
          <Button className="mt-4" onPress={onRetry} variant="outline">
            {t("retry")}
          </Button>
        )}
      </EmptyCard>
    );
  })();

  return (
    <ScrollView
      contentContainerStyle={screenStyles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      {canOpenFiles() ? (
        <Button
          loading={openingOriginal}
          onPress={() => {
            void openOriginal();
          }}
          variant="outline"
        >
          {t("openOriginal")}
        </Button>
      ) : null}
      {previewBody}
    </ScrollView>
  );
};

/**
 * The header while a document is open for editing: whether the edits are
 * stored, and Done, which saves the rest as the document's new version.
 */
const EditingStatus = ({
  phase,
  saveState,
  onDone,
}: {
  phase: "opening" | "editing" | "finishing";
  saveState: "saved" | "saving" | "notSaved";
  onDone: () => void;
}) => {
  const t = useTranslations("document.edit");
  const colors = useAppColors();
  if (phase !== "editing") {
    return <Loader />;
  }
  return (
    <View style={styles.editing}>
      <Text variant="caption">{t(saveState)}</Text>
      <Button hitSlop={8} onPress={onDone} size="inline" variant="link">
        <Text style={{ color: colors.text }} variant="headline">
          {t("done")}
        </Text>
      </Button>
    </View>
  );
};

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  editing: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
});

export default DocumentScreen;
