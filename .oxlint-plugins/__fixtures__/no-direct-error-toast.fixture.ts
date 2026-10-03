import { stellaToast as notices } from "@stll/ui/toast";

export const errorNotices = (tone: string) => {
  // oxlint-disable-next-line no-direct-error-toast/no-direct-error-toast -- fixture proves direct error creation is confined
  notices.add({ type: "error", title: "Failed" });
  const descriptor = { type: "error" as const, title: "Failed" };
  // oxlint-disable-next-line no-direct-error-toast/no-direct-error-toast -- fixture proves named error descriptors are confined
  notices.update("id", descriptor);
  const { add: create } = notices;
  // oxlint-disable-next-line no-direct-error-toast/no-direct-error-toast -- fixture proves method aliases cannot evade the owner
  create({ type: "error", title: "Failed" });
  // oxlint-disable-next-line no-direct-error-toast/no-direct-error-toast -- fixture proves dynamic discriminators require a shared error owner
  notices.add({ type: tone, title: "Outcome" });
  // oxlint-disable-next-line no-direct-error-toast/no-direct-error-toast -- fixture proves promise rejection handling stays with the shared error owner
  void notices.promise(Promise.resolve("done"), {
    loading: "Working",
    success: "Done",
    error: "Failed",
  });
  // expect-clean: no-direct-error-toast/no-direct-error-toast
  notices.add({ type: "success", title: "Saved" });
};
