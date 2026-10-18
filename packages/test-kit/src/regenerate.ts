const REGENERATION_FLAG = "STELLA_UPDATE_PLAN_CONTRACTS";

class RegenerationDisabledError extends Error {
  override readonly name = "RegenerationDisabledError";
}

export const writeRegeneratedFile = async (
  path: URL | string,
  contents:
    | ArrayBufferLike
    | Blob
    | NodeJS.TypedArray
    | ReadableStream
    | string,
) => {
  if (process.env[REGENERATION_FLAG] !== "1") {
    throw new RegenerationDisabledError(
      `Set ${REGENERATION_FLAG}=1 to regenerate committed test files`,
    );
  }
  return Bun.write(path, contents);
};
