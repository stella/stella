// Passive regression fixture for
// `no-native-s3-object-write/no-native-s3-object-write`.
//
// Each suppression below must remain necessary: unused-disable reporting then
// proves the rule keeps tracking direct, aliased, and AWS SDK write paths.

declare const getS3: () => {
  write: (key: string, body: Uint8Array) => Promise<void>;
};
declare const getCorpusS3: typeof getS3;
declare const client: { send: (command: unknown) => Promise<void> };
declare const PutObjectCommand: new (input: Record<string, unknown>) => unknown;
declare const S3Client: new (
  options: Record<string, unknown>,
) => ReturnType<typeof getS3>;
declare const writeS3ObjectWithRetry: (object: {
  key: string;
  data: Uint8Array;
}) => Promise<void>;

const key = "organization/workspace/file.pdf";
const bytes = new Uint8Array();

// oxlint-disable-next-line no-native-s3-object-write/no-native-s3-object-write
await getS3().write(key, bytes);

const documentsClient = getS3();
// oxlint-disable-next-line no-native-s3-object-write/no-native-s3-object-write
await documentsClient.write(key, bytes);

// oxlint-disable-next-line no-native-s3-object-write/no-native-s3-object-write, typescript/dot-notation -- computed-property bypass fixture
await getS3()["write"](key, bytes);

const ownClient = new S3Client({ bucket: "documents" });
// oxlint-disable-next-line no-native-s3-object-write/no-native-s3-object-write
await ownClient.write(key, bytes);

// oxlint-disable-next-line no-native-s3-object-write/no-native-s3-object-write
await new Bun.S3Client({ bucket: "documents" }).write(key, bytes);

const command = new PutObjectCommand({ Key: key });
// oxlint-disable-next-line no-native-s3-object-write/no-native-s3-object-write
await client.send(command);

// Corpus publication and the shared retry boundary are intentionally distinct.
await getCorpusS3().write(key, bytes);
await writeS3ObjectWithRetry({ data: bytes, key });

// Provenance follows bindings, not a parameter merely named like an S3 client.
const writeWithClient = async (clientParameter: ReturnType<typeof getS3>) =>
  await clientParameter.write(key, bytes);

export { writeWithClient };
