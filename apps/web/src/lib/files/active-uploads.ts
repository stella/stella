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

/**
 * Run one upload whose bytes live only in this page, counted as in flight
 * until it settles. Every matter-file upload (new files and new versions)
 * goes through here so a reload cannot drop it without a prompt.
 */
export const withActiveUpload = async <T>(
  upload: () => Promise<T>,
): Promise<T> => {
  const release = retainActiveUpload();
  try {
    return await upload();
  } finally {
    release();
  }
};

/** Hash one file in bounded chunks while the reload guard counts the read. */
export const hashActiveUploadFile = async (file: Blob): Promise<string> =>
  await withActiveUpload(async () => await sha256Hex(file));

/** Test seam. Production batches release themselves. */
export const resetActiveUploadsForTests = (): void => {
  useActiveUploadStore.setState({ count: 0 });
};
