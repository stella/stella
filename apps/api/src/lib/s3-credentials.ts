export type OptionalS3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

// Sentinel strings used in task definitions to signal "no static credential
// is set; resolve via the runtime IAM role". Match after trim + lowercase so
// casing and trailing whitespace do not turn a placeholder into a credential.
const STATIC_CREDENTIAL_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "",
  "use-iam-role",
]);

export const isUsableStaticCredential = (
  value: string | undefined,
): value is string =>
  value !== undefined &&
  !STATIC_CREDENTIAL_PLACEHOLDERS.has(value.trim().toLowerCase());

export const credentialsFromEnvValues = (
  accessKeyId: string | undefined,
  secretAccessKey: string | undefined,
): OptionalS3Credentials | null => {
  if (
    !isUsableStaticCredential(accessKeyId) ||
    !isUsableStaticCredential(secretAccessKey)
  ) {
    return null;
  }

  return { accessKeyId, secretAccessKey };
};
