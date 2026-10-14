import { useUnsavedWork } from "@/hooks/use-unsaved-work";
import { useActiveUpload } from "@/lib/files/active-uploads";

/** Warn before a reload drops an in-flight matter upload. */
export const UploadUnloadGuard = () => {
  const active = useActiveUpload();
  useUnsavedWork({
    guard: "unload",
    isDirty: active,
    surface: "file-upload",
  });
  return null;
};
