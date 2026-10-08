import { stellaToast } from "./toast";

export const createErrorToasts = (detail: string) => ({
  error: (reason: string) => stellaToast.error(reason, { description: detail }),
  add: (reason: string) =>
    stellaToast.add({ title: reason, description: detail, type: "error" }),
  update: (reason: string) => {
    const id = stellaToast.loading("Verifying");
    stellaToast.update(id, {
      title: reason,
      description: detail,
      type: "error",
    });
    return id;
  },
  promise: (reason: string) =>
    stellaToast.promise(Promise.reject(new Error(reason)), {
      loading: "Verifying",
      success: "Verified",
      error: () => ({ title: reason, description: detail }),
    }),
});
