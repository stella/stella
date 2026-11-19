import { ASIC_FILE_KINDS } from "@stll/api-contract/legal-file-formats";

import { createArchivePreviewEndpoint } from "@/api/handlers/files/archive-preview";
import { readAsicPreview } from "@/api/lib/files/archive-preview";

export default createArchivePreviewEndpoint(ASIC_FILE_KINDS, readAsicPreview);
