import { TaggedError } from "better-result";

export class SsrDocumentAssertionError extends TaggedError(
  "SsrDocumentAssertionError",
)<{
  code:
    | "forbidden-content"
    | "invalid-content-type"
    | "missing-content"
    | "unexpected-status";
  marker?: string | undefined;
  message: string;
}> {}

type AssertSsrDocumentOptions = {
  contentType: string | null;
  expectedStatus?: number | undefined;
  forbiddenContent?: readonly string[] | undefined;
  html: string;
  requiredContent: readonly string[];
  status: number;
};

export const assertSsrDocument = ({
  contentType,
  expectedStatus = 200,
  forbiddenContent = [],
  html,
  requiredContent,
  status,
}: AssertSsrDocumentOptions): void => {
  if (status !== expectedStatus) {
    throw new SsrDocumentAssertionError({
      code: "unexpected-status",
      message: `Expected SSR response status ${expectedStatus}, received ${status}.`,
    });
  }
  const mediaType = contentType?.split(";", 1).at(0)?.trim().toLowerCase();
  if (mediaType !== "text/html") {
    throw new SsrDocumentAssertionError({
      code: "invalid-content-type",
      message: `Expected an HTML SSR response, received ${contentType ?? "no content type"}.`,
    });
  }

  for (const marker of requiredContent) {
    if (!html.includes(marker)) {
      throw new SsrDocumentAssertionError({
        code: "missing-content",
        marker,
        message: `SSR response did not contain required content: ${marker}`,
      });
    }
  }
  for (const marker of forbiddenContent) {
    if (html.includes(marker)) {
      throw new SsrDocumentAssertionError({
        code: "forbidden-content",
        marker,
        message: `SSR response contained forbidden content: ${marker}`,
      });
    }
  }
};
