import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";

/** The single minting boundary for persisted contact identities. */
export const mintContactId = (): SafeId<"contact"> => createSafeId<"contact">();
