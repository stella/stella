import ZipArchive from "jszip";

declare const bytes: ArrayBuffer;
declare const other: { loadAsync: (input: ArrayBuffer) => Promise<unknown> };

// The default import under any local name: the rule must report it.
// oxlint-disable-next-line no-raw-zip-load/no-raw-zip-load
const _staticLoad = ZipArchive.loadAsync(bytes);

// The instance form reads the same unbounded archive.
// oxlint-disable-next-line no-raw-zip-load/no-raw-zip-load
const _instanceLoad = new ZipArchive().loadAsync(bytes);

// An instance held in a variable first.
const archive = new ZipArchive();
// oxlint-disable-next-line no-raw-zip-load/no-raw-zip-load
const _variableLoad = archive.loadAsync(bytes);

// Folders share the archive's loadAsync, chained or held in a variable.
// oxlint-disable-next-line no-raw-zip-load/no-raw-zip-load
const _chainedFolderLoad = new ZipArchive().folder("word")?.loadAsync(bytes);
const folder = archive.folder("word");
// oxlint-disable-next-line no-raw-zip-load/no-raw-zip-load
const _folderLoad = folder?.loadAsync(bytes);

// Writing an archive, and an unrelated loadAsync, stay valid.
const _writer = new ZipArchive();
const _unrelated = other.loadAsync(bytes);

export const __noRawZipLoadFixture = {
  _staticLoad,
  _instanceLoad,
  _variableLoad,
  _chainedFolderLoad,
  _folderLoad,
  _writer,
  _unrelated,
};
