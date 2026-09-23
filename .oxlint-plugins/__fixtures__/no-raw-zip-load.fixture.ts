import ZipArchive from "jszip";

declare const bytes: ArrayBuffer;
declare const other: { loadAsync: (input: ArrayBuffer) => Promise<unknown> };

// The default import under any local name: the rule must report it.
// oxlint-disable-next-line no-raw-zip-load/no-raw-zip-load
const _staticLoad = ZipArchive.loadAsync(bytes);

// The instance form reads the same unbounded archive.
// oxlint-disable-next-line no-raw-zip-load/no-raw-zip-load
const _instanceLoad = new ZipArchive().loadAsync(bytes);

// Writing an archive, and an unrelated loadAsync, stay valid.
const _writer = new ZipArchive();
const _unrelated = other.loadAsync(bytes);

export const __noRawZipLoadFixture = {
  _staticLoad,
  _instanceLoad,
  _writer,
  _unrelated,
};
