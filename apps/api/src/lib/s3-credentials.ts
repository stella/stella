import { isConfigurationPlaceholder } from "@/api/lib/configuration-placeholders";

export type OptionalS3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

// A credential made only of whitespace is unusable too, where a numeric or
// URL variable would rather fail its own schema than read as unset.
export const isUsableStaticCredential = (
  value: string | undefined,
): value is string =>
  value !== undefined &&
  value.trim() !== "" &&
  !isConfigurationPlaceholder(value);

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
