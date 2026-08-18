import { describe, expect, test } from "bun:test";

import { runSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";

/** A refused-start answer as the transport delivers it: the structured
 *  detail rides beside `code`/`message` and surfaces as `details`. */
const refusal = (value: Record<string, unknown>) => ({
  status: 428,
  value: {
    code: "usage_confirmation_required",
    message:
      "This run's estimated size needs an explicit confirmation to start.",
    ...value,
  },
});

describe("runSizeConfirmationDetail", () => {
  test("reads the estimate off a well-formed refusal", () => {
    expect(
      runSizeConfirmationDetail(
        refusal({ confirmation: { estimatedUnits: 120, availableUnits: 500 } }),
      ),
    ).toEqual({ estimatedUnits: 120, availableUnits: 500 });
  });

  test("ignores the same body on any other status", () => {
    // The status check is load-bearing: a 409 with this shape must keep its
    // own meaning (an active-run conflict) and never open the dialog.
    expect(
      runSizeConfirmationDetail({
        ...refusal({
          confirmation: { estimatedUnits: 120, availableUnits: 500 },
        }),
        status: 409,
      }),
    ).toBeNull();
  });

  test("ignores a 428 whose detail is missing or malformed", () => {
    expect(runSizeConfirmationDetail(refusal({}))).toBeNull();
    expect(
      runSizeConfirmationDetail(refusal({ confirmation: "120 units" })),
    ).toBeNull();
    expect(
      runSizeConfirmationDetail(
        refusal({
          confirmation: { estimatedUnits: "120", availableUnits: 500 },
        }),
      ),
    ).toBeNull();
    expect(
      runSizeConfirmationDetail(
        refusal({ confirmation: { estimatedUnits: 120 } }),
      ),
    ).toBeNull();
  });
});
