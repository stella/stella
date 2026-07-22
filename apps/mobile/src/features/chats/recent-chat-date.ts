type FormatRecentChatDateOptions = {
  locale?: string | undefined;
  now?: Date | undefined;
};

export const formatRecentChatDate = (
  timestamp: string,
  { locale, now = new Date() }: FormatRecentChatDateOptions = {},
): string => {
  const date = new Date(timestamp);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
    }).format(date);
  }

  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
};
