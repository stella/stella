type BuildFeedbackMailtoOptions = {
  recipient: string | undefined;
  route: string;
  userEmail: string | undefined;
};

export const buildFeedbackMailto = ({
  recipient,
  route,
  userEmail,
}: BuildFeedbackMailtoOptions): string | null => {
  if (!recipient) {
    return null;
  }

  const subject = `Feedback (${route})`;
  const body = [
    "",
    "",
    "---",
    ...(userEmail ? [`From: ${userEmail}`] : []),
    `Route: ${route}`,
  ].join("\n");
  return `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
};
