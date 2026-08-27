const testArtifactPattern =
  /(?:^|\/)(?:fixtures\/|[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?|d\.ts)$|[^/]+\.playwright\.[cm]?[jt]sx?$|playwright\.config\.[cm]?[jt]sx?$)/u;

export const isPublishedTestArtifact = (file: string) =>
  testArtifactPattern.test(file);
