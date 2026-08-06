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

// A script constructing its own client rather than using an accessor.
declare const S3Client: new (
  options: Record<string, unknown>,
) => ReturnType<typeof getS3>;
const ownClient = new S3Client({ bucket: "b" });
// oxlint-disable-next-line no-native-s3-object-read/no-native-s3-object-read
const _ownClient = await ownClient.file(key).bytes();

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

export {
  _bytes,
  _corpus,
  _direct,
  _exists,
  _json,
  _localFile,
  _ownClient,
  _signed,
  _stat,
  _text,
  _viaFetch,
  _viaHandle,
};
