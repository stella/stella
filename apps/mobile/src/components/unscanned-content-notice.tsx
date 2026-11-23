import { Alert, View } from "react-native";
import { useTranslations } from "use-intl";

import type { UnscannedContentReason } from "@stll/api-contract/file-scan-warnings";
import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { AlertTriangleIcon } from "@/icons.gen";
import { useUiColors } from "@/theme";

/** What the person is told of each kind of content the scan could not read. */
const useUnscannedContentMessages = (
  reasons: readonly UnscannedContentReason[],
): string[] => {
  const t = useTranslations("document");
  return reasons.map((reason) => t(`unscannedContent.${reason}`));
};

/**
 * Says that part of a stored file, such as a password-protected file inside
 * an archive, was not scanned when it was uploaded: above the file's viewer.
 * Nothing when everything was scanned.
 */
export const UnscannedContentNotice = ({
  reasons,
}: {
  reasons: readonly UnscannedContentReason[];
}) => {
  const messages = useUnscannedContentMessages(reasons);
  if (messages.length === 0) {
    return null;
  }
  return (
    <View accessibilityRole="alert" className="bg-warning/10 gap-1 px-4 py-2">
      {messages.map((message) => (
        <Text
          className="text-warning-foreground"
          key={message}
          variant="caption"
        >
          {message}
        </Text>
      ))}
    </View>
  );
};

/**
 * The same notice where a file is named in a line, such as a chat
 * attachment chip: a warning sign whose accessible name says what the notice
 * says, and which shows it, under the file's name, when pressed.
 */
export const UnscannedContentMark = ({
  name,
  reasons,
}: {
  /** The file's name, which titles the notice the mark shows. */
  name: string;
  reasons: readonly UnscannedContentReason[];
}) => {
  const ui = useUiColors();
  const messages = useUnscannedContentMessages(reasons);
  if (messages.length === 0) {
    return null;
  }
  return (
    <Button
      accessibilityLabel={messages.join(" ")}
      className="rounded-full"
      hitSlop={6}
      onPress={() => {
        Alert.alert(name, messages.join("\n\n"));
      }}
      size="icon-xs"
      testID="unscanned-content-mark"
      variant="ghost"
    >
      <AlertTriangleIcon color={ui.warningForeground} size={14} />
    </Button>
  );
};
