import { visualRegistry } from "../../src/routes/dev/-visual-metadata";
import { expectRegisteredVisualFixture } from "../helpers/registry-fixture-test";
import { test } from "../helpers/stable-geometry";

const REGISTRY_SHARD_INDEX = 2;
const REGISTRY_SHARD_COUNT = 4;

const registryEntries = Object.entries(visualRegistry);

for (const [index, [name, { label }]] of registryEntries.entries()) {
  if (index % REGISTRY_SHARD_COUNT !== REGISTRY_SHARD_INDEX) {
    continue;
  }
  test(`renders the registered ${name} fixture with its label`, async ({
    page,
  }) => {
    await expectRegisteredVisualFixture(
      page,
      `/dev?visual=${name}`,
      name,
      label,
    );
  });
}
