import { writeRolePrivilegeCensus } from "@/api/lib/db/role-privilege-census";
import { withMigratedRolePrivilegeCensus } from "@/api/tests/helpers/role-privilege-census-fixture";

await withMigratedRolePrivilegeCensus((_database, census) => {
  writeRolePrivilegeCensus(census);
});
