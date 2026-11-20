import { describe, expect, test } from "bun:test";

import { readDownloadUrl, saveDownload } from "./save-download.js";

const archive = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x01]);

const recordingWrite = () => {
  const written: { bytes: Uint8Array; path: string }[] = [];
  return {
    write: async (path: string, bytes: Uint8Array) => {
      written.push({ bytes, path });
      await Promise.resolve();
    },
    written,
  };
};

const fetcherAnswering =
  (response: Response, seen: string[] = []) =>
  async (url: URL) => {
    seen.push(url.toString());
    return await Promise.resolve(response);
  };

describe("saving a capability's download", () => {
  test("reads the link at the top level or grouped with its expiry", () => {
    expect(readDownloadUrl({ downloadUrl: "https://files.test/a" })).toBe(
      "https://files.test/a",
    );
    expect(
      readDownloadUrl({ download: { downloadUrl: "https://files.test/b" } }),
    ).toBe("https://files.test/b");
    expect(readDownloadUrl({ fileName: "a.zip" })).toBeUndefined();
  });

  test("writes the downloaded bytes to the path and reports their size", async () => {
    const seen: string[] = [];
    const { write, written } = recordingWrite();

    const saved = await saveDownload({
      fetcher: fetcherAnswering(new Response(archive), seen),
      path: "out/contract-review.skill",
      payload: {
        downloadUrl: "https://files.test/exports/a.skill?sig=1",
        fileName: "contract-review.skill",
      },
      write,
    });

    expect(saved.isOk() && saved.value).toBe(archive.byteLength);
    expect(seen).toEqual(["https://files.test/exports/a.skill?sig=1"]);
    expect(written).toEqual([
      { bytes: archive, path: "out/contract-review.skill" },
    ]);
  });

  test.each([
    {
      case: "a result without a link",
      kind: "usage",
      payload: { fileName: "a.zip" },
      response: new Response(archive),
    },
    {
      case: "a link that is not http(s)",
      kind: "download",
      payload: { downloadUrl: "file:///etc/passwd" },
      response: new Response(archive),
    },
    {
      case: "an expired link",
      kind: "download",
      payload: { downloadUrl: "https://files.test/a.zip" },
      response: new Response("expired", { status: 403 }),
    },
  ] as const)(
    "writes nothing for $case",
    async ({ kind, payload, response }) => {
      const { write, written } = recordingWrite();

      const saved = await saveDownload({
        fetcher: fetcherAnswering(response),
        path: "a.zip",
        payload,
        write,
      });

      expect(saved.isErr() && saved.error.kind).toBe(kind);
      expect(written).toEqual([]);
    },
  );
});
