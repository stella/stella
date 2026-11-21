import path from "node:path";

type DiscoverGatedTestFilesOptions = {
  apiRoot: string;
  testFileGlob: string;
  gate: string;
};

export const discoverGatedTestFiles = async ({
  apiRoot,
  testFileGlob,
  gate,
}: DiscoverGatedTestFilesOptions) => {
  const files = [
    ...new Bun.Glob(testFileGlob).scanSync({ cwd: apiRoot, onlyFiles: true }),
  ];
  const sources = await Promise.all(
    files.map(async (testFile) => ({
      testFile,
      isGated: (await Bun.file(path.join(apiRoot, testFile)).text()).includes(
        gate,
      ),
    })),
  );
  return sources
    .filter(({ isGated }) => isGated)
    .map(({ testFile }) => testFile)
    .toSorted();
};
