/**
 * A `multipart/form-data` request body streamed from the caller's buffer.
 *
 * `FormData` with a `Blob` copies the file into the blob and serialises the
 * whole form into another buffer before sending, so a converter request held
 * the source three times. This encoder enqueues the part headers, a view of
 * the caller's bytes, and the trailer, so the only full copy is the one the
 * caller already holds. Each call builds a fresh stream, so a retried request
 * re-sends the same bytes.
 */

const CRLF = "\r\n";

type MultipartFile = {
  fieldName: string;
  fileName: string;
  bytes: Uint8Array;
};

type StreamedMultipartForm = {
  body: ReadableStream<Uint8Array>;
  contentLength: number;
  contentType: string;
};

/**
 * Quote a header parameter the way browsers serialise form data: the value
 * stays UTF-8, and only the characters that would end the quoted string or
 * the header line are percent-encoded.
 */
const quoteParameter = (value: string): string =>
  `"${value.replaceAll("\r", "%0D").replaceAll("\n", "%0A").replaceAll('"', "%22")}"`;

export const streamMultipartForm = ({
  fields,
  file,
}: {
  fields: Readonly<Record<string, string>>;
  file: MultipartFile;
}): StreamedMultipartForm => {
  const encoder = new TextEncoder();
  const boundary = `stella-${Bun.randomUUIDv7()}`;
  const fieldParts = Object.entries(fields).map(
    ([name, value]) =>
      `--${boundary}${CRLF}Content-Disposition: form-data; name=${quoteParameter(name)}${CRLF}${CRLF}${value}${CRLF}`,
  );
  const chunks: Uint8Array[] = [
    encoder.encode(
      `${fieldParts.join("")}--${boundary}${CRLF}Content-Disposition: form-data; name=${quoteParameter(file.fieldName)}; filename=${quoteParameter(file.fileName)}${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`,
    ),
    file.bytes,
    encoder.encode(`${CRLF}--${boundary}--${CRLF}`),
  ];
  const contentLength = chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.at(next);
      next += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return {
    body,
    contentLength,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};
