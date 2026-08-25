import { Result } from "better-result";

/** A display name made safe for the local file system; the server's
 *  `Content-Disposition` name wins when it is present. */
export const getExportBaseName = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) {
    return "table";
  }
  return trimmed.replaceAll(/[/:*?"<>|\\]/gu, "_");
};

export const getExportFileName = (
  contentDisposition: string | null,
): string | null => {
  if (!contentDisposition) {
    return null;
  }

  const encodedMatch = /(?:^|;)\s*filename\*=UTF-8''(?<name>[^;]+)/iu.exec(
    contentDisposition,
  );
  const encodedFileName = encodedMatch?.groups?.["name"];
  if (encodedFileName) {
    const decodedResult = Result.try(() => decodeURIComponent(encodedFileName));
    if (!Result.isError(decodedResult)) {
      return decodedResult.value;
    }
  }

  const quotedMatch = /(?:^|;)\s*filename="(?<name>[^"]*)"/iu.exec(
    contentDisposition,
  );
  if (quotedMatch?.groups?.["name"]) {
    return quotedMatch.groups["name"];
  }

  return (
    /(?:^|;)\s*filename=(?<name>[^;]+)/iu.exec(contentDisposition)?.groups?.[
      "name"
    ] ?? null
  );
};
