import path from "node:path";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Checkout enables blobless fetching implicitly when sparse-checkout is set.
// Fetch required objects before consumers start, including historical reads.
export const checkCheckoutMaterialization = (
  value: unknown,
  source: string,
): string[] => {
  const problems: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) {
        visit(child);
      }
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    for (const child of Object.values(node)) {
      visit(child);
    }
    if (
      typeof node["uses"] !== "string" ||
      !node["uses"].startsWith("actions/checkout@")
    ) {
      return;
    }
    const inputs = node["with"];
    if (!isRecord(inputs)) {
      return;
    }
    for (const input of ["filter", "sparse-checkout"]) {
      const setting = inputs[input];
      if (setting === undefined || setting === null || setting === "") {
        continue;
      }
      problems.push(
        `${source}: ${String(node["name"] ?? "checkout")} sets ${input}; checkout must materialize Git objects before consumers run`,
      );
    }
  };
  visit(value);
  return problems;
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..");
  const problems: string[] = [];
  for (const file of new Bun.Glob(".github/**/*.{yml,yaml}").scanSync({
    cwd: root,
  })) {
    const document = Bun.YAML.parse(
      await Bun.file(path.join(root, file)).text(),
    );
    problems.push(...checkCheckoutMaterialization(document, file));
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
}
