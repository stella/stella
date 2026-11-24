import { View } from "react-native";
import { useTranslations } from "use-intl";

import type { UnscannedContentReason } from "@stll/api-contract/file-scan-warnings";
import { Button } from "@stll/ui/button";
import { Loader } from "@stll/ui/loader";
import { Text } from "@stll/ui/text";

import { UnscannedContentMark } from "@/components/unscanned-content-notice";
import { FileTextIcon, ImageIcon, XIcon } from "@/icons.gen";
import { useUiColors } from "@/theme";

const NONE_UNSCANNED: readonly UnscannedContentReason[] = [];

/**
 * One attached file, as the web's attachment chip shows it: the kind of
 * file, its name, and under it its size or where it stands. A sent file part
 * of which was not scanned says so, as its document screen does. In the
 * composer it has a button that takes it off the message.
 */
export const ChatAttachmentChip = ({
  detail,
  mimeType,
  name,
  onRemove,
  status = "idle",
  unscannedContent = NONE_UNSCANNED,
}: {
  /** The size, or what is happening to the file; nothing for a sent one. */
  detail?: string | undefined;
  /** `busy` while the file is read or sent; `failed` when it could not be read. */
  status?: "idle" | "busy" | "failed";
  mimeType: string;
  name: string;
  onRemove?: (() => void) | undefined;
  /** Why some of the file's content was not scanned when it was stored. */
  unscannedContent?: readonly UnscannedContentReason[] | undefined;
}) => {
  const ui = useUiColors();
  const t = useTranslations("chat");
  const shownName = name === "" ? t("attachment") : name;
  const Icon = mimeType.startsWith("image/") ? ImageIcon : FileTextIcon;

  return (
    <View className="border-border bg-background max-w-60 flex-row items-center gap-2 rounded-xl border py-1.5 pr-1 pl-2">
      <View className="bg-secondary size-8 items-center justify-center rounded-lg">
        {status === "busy" ? (
          <Loader size="sm" />
        ) : (
          <Icon color={ui.secondaryForeground} size={16} />
        )}
      </View>
      <View className="min-w-0 shrink pr-1">
        <Text numberOfLines={1} variant="label">
          {shownName}
        </Text>
        {detail === undefined ? null : (
          <Text
            numberOfLines={1}
            variant={status === "failed" ? "error" : "caption"}
          >
            {detail}
          </Text>
        )}
      </View>
      <UnscannedContentMark name={shownName} reasons={unscannedContent} />
      {onRemove === undefined ? null : (
        <Button
          accessibilityLabel={t("removeAttachment", { name: shownName })}
          className="rounded-full"
          hitSlop={6}
          onPress={onRemove}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon color={ui.mutedForeground} size={14} />
        </Button>
      )}
    </View>
  );
};
