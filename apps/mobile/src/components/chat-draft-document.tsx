import { useState } from "react";

import {
  Modal,
  Pressable,
  StyleSheet,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { ChatAttachmentChip } from "@/components/chat-attachment-chip";
import DocumentView from "@/components/document-viewer/document-view.dom";
import { FIT_ZOOM } from "@/components/document-viewer/zoom";
import type { ChatDraftDocument } from "@/state/chat-documents";
import { draftTitleFallback } from "@/state/chat-documents";

const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The draft's pages never ask the app for bytes, edit or save. */
const IGNORED = () => undefined;
const NO_BYTES = async () => await Promise.resolve("");
const NOT_SAVED = async () => await Promise.resolve(false);

/**
 * The drafts an answer wrote with `create-document`, each a file under the
 * answer. Tapping one lays it out in pages, as the web's draft view shows
 * it, built from the source the answer stored.
 */
export const ChatDraftDocuments = ({
  drafts,
}: {
  drafts: readonly ChatDraftDocument[];
}) => {
  const t = useTranslations("chat");
  const [open, setOpen] = useState<ChatDraftDocument | null>(null);

  if (drafts.length === 0) {
    return null;
  }
  return (
    <View className="flex-row flex-wrap gap-2">
      {drafts.map((draft) => (
        <Pressable
          accessibilityHint={t("documentOpen")}
          accessibilityRole="button"
          key={draft.toolCallId}
          onPress={() => {
            setOpen(draft);
          }}
        >
          <ChatAttachmentChip
            detail={t("documentReady")}
            mimeType={DOCX_MIME_TYPE}
            name={draft.fileName}
          />
        </Pressable>
      ))}
      <Modal
        animationType="slide"
        onRequestClose={() => {
          setOpen(null);
        }}
        presentationStyle="pageSheet"
        visible={open !== null}
      >
        {open === null ? null : (
          <DraftPages
            draft={open}
            onClose={() => {
              setOpen(null);
            }}
          />
        )}
      </Modal>
    </View>
  );
};

const DraftPages = ({
  draft,
  onClose,
}: {
  draft: ChatDraftDocument;
  onClose: () => void;
}) => {
  const t = useTranslations("chat");
  const locale = useLocale();
  const scheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const [failed, setFailed] = useState(false);

  return (
    <View className="bg-background" style={styles.fill}>
      <View className="border-border flex-row items-center gap-2 border-b px-4 py-3">
        <Text className="flex-1" numberOfLines={1} variant="rowTitle">
          {draft.fileName}
        </Text>
        <Button onPress={onClose} size="sm" variant="ghost">
          {t("documentClose")}
        </Button>
      </View>
      {failed ? (
        <View className="p-4">
          <Text variant="error">{t("documentFailed")}</Text>
        </View>
      ) : (
        <DocumentView
          appearance={scheme === "dark" ? "dark" : "light"}
          clearance={insets.bottom}
          dom={{ style: styles.fill }}
          draftSource={draft.source}
          draftTitle={draftTitleFallback(draft.name)}
          editable={false}
          fileName={draft.fileName}
          kind="docx"
          locale={locale}
          onEditRequest={IGNORED}
          onEditSaved={NOT_SAVED}
          onFailed={() => {
            setFailed(true);
          }}
          onReady={IGNORED}
          readChunk={NO_BYTES}
          saveRequest={0}
          size={0}
          writeEdit={IGNORED}
          zoom={FIT_ZOOM}
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
