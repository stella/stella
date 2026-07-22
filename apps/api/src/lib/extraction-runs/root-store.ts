import { rootDb } from "@/api/db/root";

import { createExtractionRunStore } from "./store";

export const extractionRunStore = createExtractionRunStore(rootDb);
