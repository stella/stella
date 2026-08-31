import { panic } from "better-result";

export const LIBRARY_PACKAGE_ORDER = [
  "auth-model",
  "ai-catalog",
  "anonymize-chat",
  "chat",
  "country-codes",
  "business-registries",
  "conditions",
  "template-conditions",
  "docx-utils",
  "ui",
  "money",
  "calculations",
  "workspace-model",
  "workspace-ui",
] as const;

export const ALL_PACKAGE_ORDER = [...LIBRARY_PACKAGE_ORDER, "cli"] as const;

type PublishEvent = "push" | "workflow_run" | "workflow_dispatch";

type PublishPackageSelectionOptions = {
  eventName: PublishEvent;
  manualPackage: string;
  changedPaths: readonly string[];
};

const isKnownPackage = (
  packageName: string,
): packageName is (typeof ALL_PACKAGE_ORDER)[number] =>
  ALL_PACKAGE_ORDER.some((knownPackage) => knownPackage === packageName);

export const selectPublishPackages = ({
  eventName,
  manualPackage,
  changedPaths,
}: PublishPackageSelectionOptions): readonly string[] => {
  if (eventName === "workflow_run") {
    return ["cli"];
  }

  if (eventName === "workflow_dispatch") {
    if (manualPackage === "all") {
      return ALL_PACKAGE_ORDER;
    }

    if (!isKnownPackage(manualPackage)) {
      panic(`Unknown package '${manualPackage}'.`);
    }

    return [manualPackage];
  }

  const changed = new Set(changedPaths);
  const selected = LIBRARY_PACKAGE_ORDER.filter((packageName) =>
    changed.has(`packages/${packageName}/CHANGELOG.md`),
  );

  if (selected.length === 0) {
    panic(
      "Push release contains no changed library changelog; refusing an empty publish.",
    );
  }

  return selected;
};

if (import.meta.main) {
  const eventName = Bun.argv.at(2);
  const manualPackage = Bun.argv.at(3) ?? "all";
  if (
    eventName !== "push" &&
    eventName !== "workflow_run" &&
    eventName !== "workflow_dispatch"
  ) {
    panic(`Unsupported event '${eventName ?? ""}'.`);
  }

  const changedPaths = Bun.spawnSync(
    [
      "git",
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "HEAD",
      "--",
      "packages",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (changedPaths.exitCode !== 0) {
    panic(new TextDecoder().decode(changedPaths.stderr));
  }

  const paths = new TextDecoder()
    .decode(changedPaths.stdout)
    .split("\n")
    .filter((path) => path.length > 0);
  for (const packageName of selectPublishPackages({
    eventName,
    manualPackage,
    changedPaths: paths,
  })) {
    console.log(packageName);
  }
}
