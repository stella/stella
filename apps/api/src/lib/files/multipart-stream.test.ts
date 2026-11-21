import { describe, expect, test } from "bun:test";

import { streamMultipartForm } from "@/api/lib/files/multipart-stream";

const drain = async (body: ReadableStream<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  return chunks;
};

describe("streamed multipart form", () => {
  test("parses back as the same form, with an exact declared length", async () => {
    const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);
    const form = streamMultipartForm({
      file: { fieldName: "files", fileName: 'smlouva "final"\r\n.doc', bytes },
      fields: { exportNotes: "true", exportNotesInMargin: "true" },
    });

    const chunks = await drain(form.body);
    expect(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(
      form.contentLength,
    );

    const encoded = new Response(new Blob(chunks), {
      headers: { "Content-Type": form.contentType },
    });
    // oxlint-disable-next-line typescript/no-deprecated -- the body is this test's own; a standard parser reading it back is the assertion
    const parsed = await encoded.formData();
    expect(parsed.get("exportNotes")).toBe("true");
    expect(parsed.get("exportNotesInMargin")).toBe("true");
    const file = parsed.get("files");
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) {
      return;
    }
    // Quotes and line breaks cannot end the parameter or the header line.
    expect(file.name).toBe("smlouva %22final%22%0D%0A.doc");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  test("sends the caller's bytes without copying them", async () => {
    const bytes = new Uint8Array(1024 * 1024);
    const form = streamMultipartForm({
      file: { fieldName: "files", fileName: "large.doc", bytes },
      fields: {},
    });

    const chunks = await drain(form.body);

    // The only chunk the size of the source is the source itself.
    const large = chunks.filter(
      (chunk) => chunk.byteLength >= bytes.byteLength,
    );
    expect(large).toHaveLength(1);
    expect(large[0]?.buffer).toBe(bytes.buffer);
  });

  test("every call builds a fresh stream, so a retry re-sends the body", async () => {
    const bytes = new TextEncoder().encode("body");
    const build = () =>
      streamMultipartForm({
        file: { fieldName: "files", fileName: "a.txt", bytes },
        fields: {},
      });
    const first = await drain(build().body);
    const second = await drain(build().body);
    expect(second.length).toBe(first.length);
    expect(second.at(1)).toBe(bytes);
  });
});
