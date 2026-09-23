// Passive regression fixture for `s3-object-boundary/no-native-s3-object-read`
// and `s3-object-boundary/no-native-s3-object-write`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag; unused-disable reporting fails CI if the rule regresses.
// Each `expect-clean` marker names a shape the rule must accept.

import { PutObjectCommand } from "@aws-sdk/client-s3";
import * as bun from "bun";
import { S3Client, s3 as defaultClient } from "bun";

import * as storage from "@/api/lib/s3";
import {
  getCorpusS3,
  getS3,
  getS3 as documentsBucket,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";

declare const client: { send: (command: unknown) => Promise<void> };
declare const otherClient: ReturnType<typeof getS3>;

const key = "organization/workspace/file.pdf";
const bytes = new Uint8Array();

// --- no-native-s3-object-read: flagged ---

// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-read
const _direct = await getS3().file(key).arrayBuffer();

// Every body-materialising method is covered, not just arrayBuffer.
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-read
const _bytes = await getS3().file(key).bytes();
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-read
const _text = await getS3().file(key).text();
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-read
const _json = await getS3().file(key).json();

// The corpus accessor is the same read against the other bucket.
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-read
const _corpus = await getCorpusS3().file(key).bytes();

// Two-step form: the file handle is bound first, then read.
const handle = getS3().file(key);
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-read
const _viaHandle = await handle.arrayBuffer();

// Computed member reads, directly and through a file-handle local.
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-read, typescript/dot-notation -- computed member fixture
const _computedDirect = await getS3().file(key)["bytes"]();
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-read, typescript/dot-notation -- computed member fixture
const _computedHandle = await handle["text"]();

// An accessor result bound to a local keeps its provenance.
const accessorClient = getCorpusS3();
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-read
const _viaAccessorClient = await accessorClient.file(key).json();

// Aliased import of the accessor.
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-read
const _aliased = await documentsBucket().file(key).text();

// Namespace import of the accessor.
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-read
const _namespace = await storage.getCorpusS3().file(key).bytes();

// A client constructed from Bun's exported class.
const ownClient = new S3Client({ bucket: "b" });
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-read
const _ownClient = await ownClient.file(key).bytes();

// A client constructed from the Bun global.
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-read
const _directOwnClient = await new Bun.S3Client({ bucket: "b" })
  .file(key)
  .bytes();

// Bun's default client, from the global and from an aliased import.
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-read
const _defaultGlobal = await Bun.s3.file(key).text();
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-read
const _defaultImport = await defaultClient.file(key).json();

// --- no-native-s3-object-read: accepted ---

// No response body.
// expect-clean: s3-object-boundary/no-native-s3-object-read
const _exists = await getS3().file(key).exists();
// expect-clean: s3-object-boundary/no-native-s3-object-read
const _stat = await getS3().file(key).stat();

// A local file is unrelated to S3.
// expect-clean: s3-object-boundary/no-native-s3-object-read
const _localFile = await Bun.file("/tmp/example").arrayBuffer();

// A fetch Response is the sanctioned replacement.
const _signed = getS3().presign(key, { expiresIn: 60 });
// expect-clean: s3-object-boundary/no-native-s3-object-read
const _viaFetch = await (await fetch(_signed)).arrayBuffer();

// A parameter shadowing a tracked local is not known to be an S3 client.
const readShadowedClient = async (
  // oxlint-disable-next-line eslint/no-shadow -- the shadow is the case under test
  accessorClient: ReturnType<typeof getS3>,
) =>
  // expect-clean: s3-object-boundary/no-native-s3-object-read
  await accessorClient.file(key).bytes();

// A reassigned local is not known to remain an S3 client.
let reassignedClient = getS3();
void reassignedClient;
reassignedClient = otherClient;
// expect-clean: s3-object-boundary/no-native-s3-object-read
const _reassignedClient = await reassignedClient.file(key).bytes();

// --- no-native-s3-object-write: flagged ---

// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write
await getS3().write(key, bytes);

const documentsClient = getS3();
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write
await documentsClient.write(key, bytes);

// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write, typescript/dot-notation -- computed member fixture
await getS3()["write"](key, bytes);

// The corpus accessor has its own owned writer.
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write
await getCorpusS3().write(key, bytes);

// Aliased and namespace imports of the accessors.
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write
await documentsBucket().write(key, bytes);
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write
await storage.getS3().write(key, bytes);

// A write through a file handle.
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write
await getS3().file(key).write(bytes);
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write
await handle.write(bytes);

// Constructed clients.
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write
await ownClient.write(key, bytes);
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write
await new Bun.S3Client({ bucket: "documents" }).write(key, bytes);

// Bun's default client, from the global and from an aliased import.
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write
await Bun.s3.write(key, bytes);
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write
await Bun.s3.file(key).write(bytes);
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write
await defaultClient.write(key, bytes);

// `Bun.write` with an S3 file handle as the destination, from the global and
// from a namespace import.
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write
await Bun.write(getS3().file(key), bytes);
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write
await bun.write(handle, bytes);

// An AWS SDK PutObjectCommand bound to a local.
const command = new PutObjectCommand({ Bucket: "b", Key: key });
// oxlint-disable-next-line s3-object-boundary/no-native-s3-object-write
await client.send(command);

// --- no-native-s3-object-write: accepted ---

// The owned retry boundary.
// expect-clean: s3-object-boundary/no-native-s3-object-write
await writeS3ObjectWithRetry({ data: bytes, key });

// `Bun.write` to a local path.
// expect-clean: s3-object-boundary/no-native-s3-object-write
await Bun.write("/tmp/example", bytes);

// Provenance follows bindings, not a parameter named like an S3 client.
const writeWithClient = async (clientParameter: ReturnType<typeof getS3>) =>
  // expect-clean: s3-object-boundary/no-native-s3-object-write
  await clientParameter.write(key, bytes);

export {
  _aliased,
  _bytes,
  _computedDirect,
  _computedHandle,
  _corpus,
  _defaultGlobal,
  _defaultImport,
  _direct,
  _directOwnClient,
  _exists,
  _json,
  _localFile,
  _namespace,
  _ownClient,
  _reassignedClient,
  _signed,
  _stat,
  _text,
  _viaAccessorClient,
  _viaFetch,
  _viaHandle,
  readShadowedClient,
  writeWithClient,
};
