import { describe, expect, test } from "bun:test";

import { createOfficeEvidenceAdmission } from "@/api/lib/files/office-evidence-admission";

describe("Office evidence admission", () => {
  test("never admits more extraction workers than its limit", () => {
    const admission = createOfficeEvidenceAdmission(1);
    const release = admission.tryAcquire();

    expect(release).not.toBeNull();
    expect(admission.tryAcquire()).toBeNull();
    release?.();
    expect(admission.tryAcquire()).not.toBeNull();
  });
});
