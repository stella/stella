// Passive regression fixture for
// `no-native-s3-object-read/no-native-s3-object-read`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses (e.g. someone drops the two-step
// file-handle tracking or the local-client tracking), the matching disable
// becomes unused and `--report-unused-disable-directives-severity=error`
// fails CI. The un-suppressed statements at the bottom must stay clean: they
// are the shapes the rule must NOT flag.

declare const getS3: () => {
  file: (key: string) => {
    arrayBuffer: () => Promise<ArrayBuffer>;
    bytes: () => Promise<Uint8Array>;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
    exists: () => Promise<boolean>;
    stat: () => Promise<{ size: number }>;
  };
  write: (key: string, body: Uint8Array) => Promise<void>;
  delete: (key: string) => Promise<void>;
  presign: (key: string, options: { expiresIn: number }) => string;
};
declare const getCorpusS3: typeof getS3;

const key = "some/object/key";

// Direct read off the documents-bucket accessor.
// oxlint-disable-next-line no-native-s3-object-read/no-native-s3-object-read
const _direct = await getS3().file(key).arrayBuffer();

// Every body-materialising method is covered, not just arrayBuffer.
// oxlint-disable-next-line no-native-s3-object-read/no-native-s3-object-read
const _bytes = await getS3().file(key).bytes();
// oxlint-disable-next-line no-native-s3-object-read/no-native-s3-object-read
const _text = await getS3().file(key).text();
// oxlint-disable-next-line no-native-s3-object-read/no-native-s3-object-read
const _json = await getS3().file(key).json();

// The corpus accessor is the same hazard against the other bucket.
// oxlint-disable-next-line no-native-s3-object-read/no-native-s3-object-read
const _corpus = await getCorpusS3().file(key).bytes();

// Two-step form: the file handle is bound first, then read. This is the shape
// that a receiver-only check would miss.
const handle = getS3().file(key);
// oxlint-disable-next-line no-native-s3-object-read/no-native-s3-object-read
const _viaHandle = await handle.arrayBuffer();

// Static computed reads are the same native calls and must not bypass the
// rule, whether made directly or through a file-handle local.
// oxlint-disable-next-line no-native-s3-object-read/no-native-s3-object-read, typescript/dot-notation -- computed-property bypass fixture
const _computedDirect = await getS3().file(key)["bytes"]();
// oxlint-disable-next-line no-native-s3-object-read/no-native-s3-object-read, typescript/dot-notation -- computed-property bypass fixture
const _computedHandle = await handle["text"]();

// Binding an accessor result first must retain the S3-client provenance.
const accessorClient = getCorpusS3();
// oxlint-disable-next-line no-native-s3-object-read/no-native-s3-object-read
const _viaAccessorClient = await accessorClient.file(key).json();

// A script constructing its own client rather than using an accessor.
declare const S3Client: new (
  options: Record<string, unknown>,
) => ReturnType<typeof getS3>;
const ownClient = new S3Client({ bucket: "b" });
// oxlint-disable-next-line no-native-s3-object-read/no-native-s3-object-read
const _ownClient = await ownClient.file(key).bytes();

// A direct construction must not bypass provenance tracking.
// oxlint-disable-next-line no-native-s3-object-read/no-native-s3-object-read
const _directOwnClient = await new Bun.S3Client({
  bucket: "b",
  accessKeyId: "a",
  secretAccessKey: "s",
})
  .file(key)
  .bytes();

// --- Must NOT be flagged: no response body, so nothing to leak. ---

const _exists = await getS3().file(key).exists();
const _stat = await getS3().file(key).stat();
const _signed = getS3().presign(key, { expiresIn: 60 });
await getS3().write(key, new Uint8Array());
await getS3().delete(key);

// Reading a *local* file is unrelated to the S3 download path.
const _localFile = await Bun.file("/tmp/example").arrayBuffer();

// A fetch Response is the sanctioned replacement and must stay clean.
const _viaFetch = await (await fetch(_signed)).arrayBuffer();

// Provenance follows lexical bindings, not identifier spelling. Neither a
// shadowed parameter nor a reassigned local is known to remain an S3 client.
// oxlint-disable-next-line eslint/no-shadow -- the shadow is the regression shape
const readShadowedClient = async (accessorClient: ReturnType<typeof getS3>) =>
  await accessorClient.file(key).bytes();
let reassignedClient = getS3();
reassignedClient = {
  ...reassignedClient,
  file: () => ({
    arrayBuffer: async () => await Promise.resolve(new ArrayBuffer(0)),
    bytes: async () => await Promise.resolve(new Uint8Array()),
    text: async () => await Promise.resolve(""),
    json: async () => await Promise.resolve(null),
    exists: async () => await Promise.resolve(false),
    stat: async () => await Promise.resolve({ size: 0 }),
  }),
};
const _reassignedClient = await reassignedClient.file(key).bytes();

export {
  _bytes,
  _computedDirect,
  _computedHandle,
  _corpus,
  _direct,
  _directOwnClient,
  _exists,
  _json,
  _localFile,
  _ownClient,
  _signed,
  _stat,
  _text,
  _reassignedClient,
  _viaFetch,
  _viaAccessorClient,
  _viaHandle,
  readShadowedClient,
};
