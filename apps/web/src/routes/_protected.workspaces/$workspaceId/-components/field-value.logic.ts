export const getClipFieldValueLabel = ({
  citation,
  url,
}: {
  citation: string | null | undefined;
  url: string;
}) => {
  const trimmedCitation = citation?.trim();

  if (trimmedCitation) {
    return trimmedCitation;
  }

  return url;
};
