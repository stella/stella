import { useUserStorageState } from "@/lib/account/use-user-storage-state";

import {
  DOCX_OUTLINE_DEPTH_STORAGE_KEY,
  parseDocxOutlineDepth,
} from "./docx-outline-depth.logic";

export const useDocxOutlineDepth = () => {
  const { value: depth, setValue: setDepth } = useUserStorageState({
    baseKey: DOCX_OUTLINE_DEPTH_STORAGE_KEY,
    area: "local",
    decode: parseDocxOutlineDepth,
    encode: String,
  });
  return { depth, setDepth };
};
