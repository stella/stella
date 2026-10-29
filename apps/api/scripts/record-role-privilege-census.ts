import { withMigratedRolePrivilegeCensus } from "../src/tests/helpers/role-privilege-census-fixture";

if (Bun.argv.length !== 3 || Bun.argv.at(2) !== "--write") {
  process.stderr.write(
    "Usage: bun scripts/record-role-privilege-census.ts --write\n",
  );
  process.exit(1);
}

await withMigratedRolePrivilegeCensus(async (_database, census) => {
  await Bun.write(
    new URL("../src/lib/db/role-privilege-census.json", import.meta.url),
    `${JSON.stringify(census, null, 2)}\n`,
  );
});
