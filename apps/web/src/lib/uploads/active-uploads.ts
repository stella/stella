import { create } from "zustand";

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

/** Test seam. Production batches release themselves. */
export const resetActiveUploadsForTests = (): void => {
  useActiveUploadStore.setState({ count: 0 });
};
