import { Result, TaggedError } from "better-result";

export class DataUrlError extends TaggedError("DataUrlError")<{
  message: string;
  cause?: unknown;
}>() {}

export const toDataUrl = (bytes: Uint8Array, mimeType: string) =>
  `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;

type ValidateDataUrlProps = {
  url: string;
  expectedMimeType?: string | undefined;
};

type ValidateDataUrlResult = Result<
  {
    mimeType: string;
    payload: string;
  },
  DataUrlError
>;

export const validateDataUrl = ({
  url,
  expectedMimeType,
}: ValidateDataUrlProps): ValidateDataUrlResult => {
  const commaIndex = url.indexOf(",");

  if (!url.startsWith("data:") || commaIndex === -1) {
    return Result.err(
      new DataUrlError({
        message: "Data URLs must start with 'data:'",
      }),
    );
  }

  const metadata = url.slice(5, commaIndex);
  const payload = url.slice(commaIndex + 1);
  const metadataParts = metadata.split(";");
  const mimeType = metadataParts[0] ?? "";

  if (!mimeType || !metadataParts.includes("base64")) {
    return Result.err(
      new DataUrlError({
        message: "Data URLs must use base64 encoding",
      }),
    );
  }

  if (expectedMimeType && mimeType !== expectedMimeType) {
    return Result.err(
      new DataUrlError({
        message: "Data URL MIME type does not match expected type",
      }),
    );
  }

  return Result.ok({
    mimeType,
    payload,
  });
};

type ParseDataUrlProps = {
  expectedMimeType?: string | undefined;
  url: string;
};

export type ParsedDataUrl = {
  bytes: Uint8Array;
  mimeType: string;
};

type ParseDataUrlResult = Result<ParsedDataUrl, DataUrlError>;

export const parseDataUrl = ({
  expectedMimeType,
  url,
}: ParseDataUrlProps): ParseDataUrlResult =>
  Result.gen(function* () {
    const validatedDataUrl = yield* validateDataUrl({
      expectedMimeType,
      url,
    });

    const decodedPayload = yield* Result.try({
      try: () => Buffer.from(validatedDataUrl.payload, "base64"),
      catch: (cause) =>
        new DataUrlError({
          message: "Failed to parse data URL payload",
          cause,
        }),
    });

    return Result.ok({
      bytes: new Uint8Array(decodedPayload),
      mimeType: validatedDataUrl.mimeType,
    });
  });
