import { use, useState } from "react";

import { Result } from "better-result";
import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import type { EmailReading as EmailReadingData } from "@stll/api-contract/email-reading";
import {
  LIST_SEARCH_MIN_ROWS,
  listRowMatches,
} from "@stll/api-contract/list-search";
import {
  type MailboxMessage,
  mailboxMessageDetails,
  type MailboxPreview,
} from "@stll/api-contract/mailbox";
import { Button } from "@stll/ui/button";
import { formatFileSize } from "@stll/ui/file-size";
import { Input } from "@stll/ui/input";
import { Loader } from "@stll/ui/loader";
import { Separator } from "@stll/ui/separator";
import { Text } from "@stll/ui/text";

import { EmailReading } from "@/components/email-reading";
import { FilePartOpenerContext } from "@/components/file-part-list";
import { ArrowLeftIcon, MailIcon } from "@/icons.gen";
import { useUiColors } from "@/theme";

const ICON_SIZE = 18;

const MESSAGE_DATE_FORMAT = {
  dateStyle: "medium",
  timeStyle: "short",
} as const satisfies Intl.DateTimeFormatOptions;

/** The message open in place, as far as it has been read. */
type OpenMessage =
  | { readonly status: "loading"; readonly message: MailboxMessage }
  | { readonly status: "failed"; readonly message: MailboxMessage }
  | {
      readonly status: "open";
      readonly message: MailboxMessage;
      readonly reading: EmailReadingData;
    };

/** One message as a row: its subject, then who sent it, when and where. */
const MessageRow = ({
  divided,
  message,
  onOpen,
}: {
  divided: boolean;
  message: MailboxMessage;
  onOpen: (message: MailboxMessage) => void;
}) => {
  const email = useTranslations("email");
  const fileParts = useTranslations("fileParts");
  const format = useFormatter();
  const ui = useUiColors();
  const subject = message.subject ?? email("noSubject");
  const details = [
    ...mailboxMessageDetails(message, (date) =>
      format.dateTime(date, MESSAGE_DATE_FORMAT),
    ),
    ...(message.unavailable === null
      ? []
      : [fileParts(`unavailable.${message.unavailable}`)]),
    formatFileSize(message.sizeBytes, format),
  ].join(" · ");
  const icon = (
    <View className="pt-0.5">
      <MailIcon color={ui.mutedForeground} size={ICON_SIZE} />
    </View>
  );
  const text = (
    <View className="flex-1 gap-0.5">
      <Text numberOfLines={2} variant="rowTitle">
        {subject}
      </Text>
      <Text numberOfLines={2} variant="caption">
        {details}
      </Text>
    </View>
  );
  const separator = divided ? (
    <Separator className="absolute inset-x-0 bottom-0" />
  ) : null;
  if (message.part === null) {
    return (
      <View
        accessible
        accessibilityLabel={`${subject}, ${details}`}
        className="min-h-11 w-full flex-row items-start gap-3 py-3 opacity-70"
      >
        {separator}
        {icon}
        {text}
      </View>
    );
  }
  return (
    <Button
      accessibilityLabel={`${subject}, ${details}`}
      icon={icon}
      onPress={() => {
        onOpen(message);
      }}
      size="row"
      variant="ghost"
    >
      {separator}
      {text}
    </Button>
  );
};

/**
 * A mailbox's messages in the order it stores them; a message opens in
 * place as the email it is, with its attachments opening by their paths
 * through it, and the way back to the list. A message that does not open
 * (too large, damaged) is listed with why.
 */
export const MailboxMessages = ({
  preview,
  readMessage,
}: {
  preview: MailboxPreview;
  /** Reads one message (`message:N`) as an email. */
  readMessage: (part: string) => Promise<Result<EmailReadingData, unknown>>;
}) => {
  const t = useTranslations("mailbox");
  const document = useTranslations("document");
  const opener = use(FilePartOpenerContext);
  const ui = useUiColors();
  const [open, setOpen] = useState<OpenMessage | null>(null);
  const [query, setQuery] = useState("");
  const read = async (message: MailboxMessage) => {
    const { part } = message;
    if (part === null) {
      return;
    }
    // Each attempt is its own state: only the attempt still showing settles.
    const loading: OpenMessage = { status: "loading", message };
    setOpen(loading);
    const reading = await readMessage(part.part);
    const settled: OpenMessage = Result.isOk(reading)
      ? { status: "open", message, reading: reading.value }
      : { status: "failed", message };
    setOpen((current) => (current === loading ? settled : current));
  };

  if (open !== null) {
    const { part } = open.message;
    return (
      <View className="gap-4">
        <Button
          icon={<ArrowLeftIcon color={ui.foreground} size={ICON_SIZE} />}
          onPress={() => {
            setOpen(null);
          }}
          size="sm"
          variant="outline"
        >
          {t("back")}
        </Button>
        {open.status === "loading" ? <Loader /> : null}
        {open.status === "failed" ? (
          <Button
            onPress={() => {
              void read(open.message);
            }}
            size="sm"
            variant="ghost"
          >
            {t("openFailed")}
          </Button>
        ) : null}
        {open.status === "open" ? <EmailReading read={open.reading} /> : null}
        {opener === null || part === null ? null : (
          // The message itself still opens as a file, as any part does.
          <Button
            loading={opener.opening === part.part}
            onPress={() => {
              opener.open(part.part, part.mediaType);
            }}
            size="sm"
            variant="outline"
          >
            {document("openOriginal")}
          </Button>
        )}
      </View>
    );
  }
  if (preview.messages.length === 0) {
    return <Text variant="caption">{t("noMessages")}</Text>;
  }
  const shown = preview.messages.flatMap((message, position) =>
    listRowMatches(
      [message.subject, message.from, message.folder, message.fileName],
      query,
    )
      ? [{ message, position }]
      : [],
  );
  return (
    <View>
      <Text accessibilityRole="header" variant="section">
        {t("messages")}
      </Text>
      {preview.truncated ? (
        <Text variant="caption">
          {t("truncated", { count: preview.messages.length })}
        </Text>
      ) : null}
      {preview.messages.length >= LIST_SEARCH_MIN_ROWS ? (
        <Input
          accessibilityLabel={t("search")}
          autoCapitalize="none"
          onChangeText={setQuery}
          placeholder={t("search")}
          type="search"
          value={query}
        />
      ) : null}
      {shown.length === 0 ? (
        <Text variant="caption">{t("noMatches", { query: query.trim() })}</Text>
      ) : null}
      {shown.map(({ message, position }, row) => (
        <MessageRow
          divided={row < shown.length - 1}
          key={message.part?.part ?? `unavailable:${String(position)}`}
          message={message}
          onOpen={(opened) => {
            void read(opened);
          }}
        />
      ))}
    </View>
  );
};
