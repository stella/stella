import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Result } from "better-result";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  useColorScheme,
  View,
} from "react-native";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import DocumentView from "@/components/document-viewer/document-view.dom";
import { FIT_ZOOM, pageAppearance } from "@/components/document-viewer/zoom";
import type { ViewerAppearance } from "@/components/document-viewer/zoom";
import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { LucideGlyphs } from "@/components/ui/lucide-glyphs";
import { ViewerControls } from "@/components/viewer-controls";
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
import { isOffline, readDocumentFile } from "@/state/document-file";
import type { DocumentFile } from "@/state/document-file";
import { useAppColors } from "@/theme";

type Failure = "offline" | "noFile" | "failed" | "unsupported" | "android";

type Phase =
  | { readonly status: "opening" }
  | { readonly status: "failed"; readonly failure: Failure }
  | {
      readonly status: "open";
      readonly file: DocumentFile;
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
  if (!canOpenFiles()) {
    // An older iPhone build gains the viewer by updating; Android has none.
    return {
      status: "failed",
      failure: Platform.OS === "android" ? "android" : "unsupported",
    };
  }
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
 * by folio and a PDF drawn by pdf.js, as the web app shows them; any other
 * file opens in the system's Quick Look. The file stays on the phone only
 * while this screen is open. A retry opens it afresh.
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

  const title =
    phase.status === "open" ? phase.file.fileName : (name ?? t("title"));

  const body = (() => {
    if (source === null || phase.status === "opening") {
      return <ActivityIndicator color={colors.muted} style={styles.center} />;
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
    const { file, opened } = phase;
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
          kind={file.viewer}
          locale={locale}
          onFailed={() => {
            if (mounted.current) {
              setPhase({ ...phase, unrendered: true });
            }
          }}
          onReady={() => {
            if (mounted.current) {
              setReady(true);
            }
          }}
          readChunk={async (offset: number, length: number) => {
            const slice = await readOpenedFile(opened, offset, length);
            return mounted.current ? slice : await UNANSWERED;
          }}
          size={opened.size}
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
            <ActivityIndicator color={colors.muted} />
          </View>
        )}
      </View>
    );
  })();

  return (
    <View style={[screenStyles.screen, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              accessibilityLabel={t("details")}
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => {
                router.push({
                  pathname: "/matter/[workspaceId]/[entityId]",
                  params: { workspaceId, entityId },
                });
              }}
            >
              <LucideGlyphs color={colors.text} name="info" size={22} />
            </Pressable>
          ),
          title,
        }}
      />
      {body}
    </View>
  );
};

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
});

export default DocumentScreen;
