import { ActivityIndicator, Pressable, View } from "react-native";
import { useTranslations } from "use-intl";

import { Text } from "@stll/ui/text";

import { FileTextIcon, ImageIcon, XIcon } from "@/icons.gen";
import { useUiColors } from "@/theme";

/**
 * One attached file, as the web's attachment chip shows it: the kind of
 * file, its name, and under it its size or where it stands. In the composer
 * it has a button that takes it off the message.
 */
export const ChatAttachmentChip = ({
  detail,
  mimeType,
  name,
  onRemove,
  status = "idle",
}: {
  /** The size, or what is happening to the file; nothing for a sent one. */
  detail?: string | undefined;
  /** `busy` while the file is read or sent; `failed` when it could not be read. */
  status?: "idle" | "busy" | "failed";
  mimeType: string;
  name: string;
  onRemove?: (() => void) | undefined;
}) => {
  const ui = useUiColors();
  const t = useTranslations("chat");
  const shownName = name === "" ? t("attachment") : name;
  const Icon = mimeType.startsWith("image/") ? ImageIcon : FileTextIcon;

  return (
    <View className="border-border bg-background max-w-60 flex-row items-center gap-2 rounded-xl border py-1.5 pr-1 pl-2">
      <View className="bg-secondary size-8 items-center justify-center rounded-lg">
        {status === "busy" ? (
          <ActivityIndicator color={ui.mutedForeground} size="small" />
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
      {onRemove === undefined ? null : (
        <Pressable
          accessibilityLabel={t("removeAttachment", { name: shownName })}
          accessibilityRole="button"
          className="size-7 items-center justify-center rounded-full"
          hitSlop={6}
          onPress={onRemove}
        >
          <XIcon color={ui.mutedForeground} size={14} />
        </Pressable>
      )}
    </View>
  );
};
