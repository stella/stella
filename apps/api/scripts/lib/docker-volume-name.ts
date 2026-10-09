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

export type DockerContainerName = string & {
  readonly __brand: "DockerContainerName";
};

// Container names share the volume-name charset. Same contract: internal
// constants only, panic on misuse, and the only dynamic value the guard lets
// through in a docker run option position.
export const dockerContainerName = (value: string): DockerContainerName => {
  if (!DOCKER_VOLUME_NAME.test(value)) {
    return panic(`Invalid Docker container name: ${JSON.stringify(value)}`);
  }
  // SAFETY: the pattern above is the brand's only invariant.
  return value as DockerContainerName;
};

export type DockerImageRef = string & { readonly __brand: "DockerImageRef" };

const DOCKER_IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/u;

// An image reference or ID cannot start with "-", so a validated value never
// reads as a docker run option.
export const dockerImageRef = (value: string): DockerImageRef => {
  if (!DOCKER_IMAGE_REF.test(value)) {
    return panic(`Invalid Docker image reference: ${JSON.stringify(value)}`);
  }
  // SAFETY: the pattern above is the brand's only invariant.
  return value as DockerImageRef;
};
