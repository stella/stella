import { Result, TaggedError } from "better-result";

export class DataUrlError extends TaggedError("DataUrlError")<{
  message: string;
  cause?: unknown;
}>() {}

export const DATA_URL_PAYLOAD_TOO_LARGE_MESSAGE =
  "Data URL payload exceeds size limit";

export const toDataUrl = (bytes: Uint8Array, mimeType: string) =>
  `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;

type ValidateDataUrlProps = {
  expectedMimeType?: string | undefined;
  maxBytes?: number | undefined;
  url: string;
};

type ValidateDataUrlResult = Result<
  {
    mimeType: string;
    payload: string;
  },
  DataUrlError
>;

export const validateDataUrl = ({
  expectedMimeType,
  maxBytes,
  url,
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
  const payloadStartIndex = commaIndex + 1;
  const metadataParts = metadata.split(";");
  const mimeType = metadataParts[0] ?? "";

  if (!mimeType || !metadataParts.includes("base64")) {
    return Result.err(
      new DataUrlError({
        message: "Data URLs must use base64 encoding",
      }),
    );
  }

  const payloadLength = url.length - payloadStartIndex;
  if (
    maxBytes !== undefined &&
    payloadLength > getMaxBase64PayloadLength(maxBytes)
  ) {
    return Result.err(
      new DataUrlError({
        message: DATA_URL_PAYLOAD_TOO_LARGE_MESSAGE,
      }),
    );
  }

  const payload = url.slice(payloadStartIndex);

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
  maxBytes: number;
  url: string;
};

export type ParsedDataUrl = {
  bytes: Uint8Array;
  mimeType: string;
};

type ParseDataUrlResult = Result<ParsedDataUrl, DataUrlError>;

export const parseDataUrl = ({
  expectedMimeType,
  maxBytes,
  url,
}: ParseDataUrlProps): ParseDataUrlResult =>
  Result.gen(function* () {
    const validatedDataUrl = yield* validateDataUrl({
      expectedMimeType,
      maxBytes,
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

    if (decodedPayload.byteLength > maxBytes) {
      return Result.err(
        new DataUrlError({
          message: DATA_URL_PAYLOAD_TOO_LARGE_MESSAGE,
        }),
      );
    }

    return Result.ok({
      bytes: new Uint8Array(decodedPayload),
      mimeType: validatedDataUrl.mimeType,
    });
  });

const getMaxBase64PayloadLength = (maxBytes: number) =>
  Math.ceil(maxBytes / 3) * 4;

export const isDataUrlSizeLimitError = (error: DataUrlError) =>
  error.message === DATA_URL_PAYLOAD_TOO_LARGE_MESSAGE;
