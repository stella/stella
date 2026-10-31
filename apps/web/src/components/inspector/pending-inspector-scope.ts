import { createContext } from "react";

import type { InspectorStorageScope } from "@/components/inspector/inspector-storage-keys";

export const PendingInspectorScopeContext = createContext<
  InspectorStorageScope | undefined
>(undefined);
