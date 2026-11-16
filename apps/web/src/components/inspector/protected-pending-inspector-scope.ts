import { createContext } from "react";

import type { InspectorStorageScope } from "@/components/inspector/inspector-storage-keys";

export const ProtectedPendingInspectorScopeContext = createContext<
  InspectorStorageScope | undefined
>(undefined);
