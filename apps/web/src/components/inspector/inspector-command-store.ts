import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import { createInspectorCommandSlice } from "@/components/inspector/inspector-command-slice";
import type { InspectorCommandStore } from "@/components/inspector/inspector-store-types";

export const useInspectorCommandStore = create<InspectorCommandStore>()(
  immer((set) => createInspectorCommandSlice(set)),
);
