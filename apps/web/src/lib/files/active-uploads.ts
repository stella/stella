import { create } from "zustand";

import { sha256Hex } from "@stll/sha256/browser";

type ActiveUploadState = {
  count: number;
};

const useActiveUploadStore = create<ActiveUploadState>(() => ({ count: 0 }));

/** True while at least one file-upload batch is still in flight. */
export const hasActiveUpload = (): boolean =>
  useActiveUploadStore.getState().count > 0;

/** Subscribes a mounted guard to the same in-flight signal. */
export const useActiveUpload = (): boolean =>
  useActiveUploadStore((state) => state.count > 0);

/**
 * Count one in-flight upload batch. The returned release is idempotent:
 * a batch that both finishes and is cancelled must not drop the count
 * below the batches that are still running.
 */
export const retainActiveUpload = (): (() => void) => {
  useActiveUploadStore.setState((state) => ({ count: state.count + 1 }));
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    useActiveUploadStore.setState((state) => ({ count: state.count - 1 }));
  };
};

// Nominal through the private field, and the class stays private to this
// module: only `withActiveUpload` hands one out.
class ActiveUploadProof {
  readonly #counted = true;

  static readonly instance = new ActiveUploadProof();

  get counted(): boolean {
    return this.#counted;
  }
}

/** Proof that the caller runs inside an upload counted as in flight. */
export type ActiveUpload = ActiveUploadProof;

/**
 * Run one upload whose bytes live only in this page, counted as in flight
 * until it settles. Every matter-file upload (new files and new versions)
 * goes through here so a reload cannot drop it without a prompt.
 */
export const withActiveUpload = async <T>(
  upload: (active: ActiveUpload) => Promise<T>,
): Promise<T> => {
  const release = retainActiveUpload();
  try {
    return await upload(ActiveUploadProof.instance);
  } finally {
    release();
  }
};

/**
 * SHA-256 of a file about to be uploaded, read once in bounded chunks. It
 * takes the upload's proof, so the whole read runs while a reload prompts.
 */
export const hashUploadFile = async (
  _active: ActiveUpload,
  file: Blob,
): Promise<string> => await sha256Hex(file);

/** Test seam. Production batches release themselves. */
export const resetActiveUploadsForTests = (): void => {
  useActiveUploadStore.setState({ count: 0 });
};
