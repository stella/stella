import { ClientOperationError } from "@/lib/errors/client";

type CompleteEntityVersionUploadOptions<TResult> = {
  abort: () => Promise<void>;
  finalize: () => Promise<TResult>;
  put: () => Promise<Response>;
};

export const completeEntityVersionUpload = async <TResult>({
  abort,
  finalize,
  put,
}: CompleteEntityVersionUploadOptions<TResult>): Promise<TResult> => {
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

  return await finalize();
};
