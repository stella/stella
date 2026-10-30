import { expect, test } from "bun:test";

import { nssPublisherColumns } from "./nss-publisher-columns";

test("publisher columns retain text verbatim and leave absent values nullable", () => {
  const columns = nssPublisherColumns({
    nssReporterNumber: "003540",
    nssRegistryReferralDate: "26.5.2016",
    nssRegistryAnnotation: "Pravomoc rozšířeného senátu",
  });
  expect(columns.nssReporterNumber).toBe("003540");
  expect(columns.nssRegistryReferralDate).toBe("26.5.2016");
  expect(columns.nssRegistryAnnotation).toBe("Pravomoc rozšířeného senátu");
  expect(columns.nssReporterYear).toBeNull();
  expect(() => nssPublisherColumns({ nssRegistryStatus: 42 })).toThrow(
    "NSS publisher metadata nssRegistryStatus must be text",
  );
});
