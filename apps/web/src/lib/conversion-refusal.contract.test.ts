import { expectTypeOf, test } from "bun:test";

import type { ConversionRefusal as ApiConversionRefusal } from "@stll/api-contract/conversion-refusal";
import type { ConversionRefusal as WorkspaceConversionRefusal } from "@stll/workspace-ui/types";

test("the published workspace type matches the API conversion refusal", () => {
  expectTypeOf<WorkspaceConversionRefusal>().toEqualTypeOf<ApiConversionRefusal>();
});
