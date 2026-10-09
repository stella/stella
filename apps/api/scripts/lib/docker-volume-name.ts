import { panic } from "better-result";

export type DockerVolumeName = string & {
  readonly __brand: "DockerVolumeName";
};

const DOCKER_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

// Docker's volume-name charset excludes the comma and equals sign that
// delimit --mount options. Every caller passes a name built from internal
// constants, so a violation is programmer misuse: panic rather than return a
// Result. scripts/check-docker-host-mounts.ts accepts interpolation into a
// mount string only through this function.
export const dockerVolumeName = (value: string): DockerVolumeName => {
  if (!DOCKER_VOLUME_NAME.test(value)) {
    return panic(`Invalid Docker volume name: ${JSON.stringify(value)}`);
  }
  // SAFETY: the pattern above is the brand's only invariant.
  return value as DockerVolumeName;
};
