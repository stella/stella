import { expectTypeOf } from "bun:test";

import type { ContactUpdateFields } from "@/lib/contacts/mutations";
import type {
  ContactMetadata,
  ContactPatch,
} from "@/routes/_protected.contacts/-components/types";

expectTypeOf<{ metadata: ContactMetadata }>().not.toExtend<ContactPatch>();
expectTypeOf<{ metadata: null }>().not.toExtend<ContactPatch>();
expectTypeOf<{ dataBoxes: []; customFields: [] }>().not.toExtend<
  ContactUpdateFields["metadata"]
>();
expectTypeOf<{ metadata: { dataBoxes: [] } }>().toExtend<ContactPatch>();
expectTypeOf<{ metadata: { customFields: [] } }>().toExtend<ContactPatch>();
