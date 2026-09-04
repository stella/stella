import { ClientOperationError } from "@/lib/errors/client";

type CompleteEntityVersionUploadOptions = {
  abort: () => Promise<void>;
  finalize: () => Promise<void>;
  put: () => Promise<Response>;
};

export const completeEntityVersionUpload = async ({
  abort,
  finalize,
  put,
}: CompleteEntityVersionUploadOptions): Promise<void> => {
  let putResponse: Response;
  try {
    putResponse = await put();
  } catch (error) {
    await abort();
    throw error;
  }

  if (!putResponse.ok) {
    await abort();
    throw new ClientOperationError({
      action: "upload-version-to-s3",
      message: `S3 rejected upload (${putResponse.status})`,
    });
  }

  await finalize();
};
