import { writeFileSync } from "node:fs";

type WriteRegeneratedFileOptions = {
  flag: string;
  value: string;
  file: string | URL;
  contents: string | Uint8Array;
  environment?: Readonly<Record<string, string | undefined>>;
};

class RegenerationFlagError extends Error {
  override readonly name = "RegenerationFlagError";
}

/** Write a checked-in test artifact only after an explicit opt-in. */
export const writeRegeneratedFile = ({
  flag,
  value,
  file,
  contents,
  environment = process.env,
}: WriteRegeneratedFileOptions): void => {
  if (environment[flag] !== value) {
    throw new RegenerationFlagError(
      `Set ${flag}=${value} to regenerate this file`,
    );
  }
  writeFileSync(file, contents);
};
