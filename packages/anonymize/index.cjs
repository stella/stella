"use strict";

exports.loadNativeBinding = () => {
  if (process.platform === "darwin" && process.arch === "arm64") {
    try {
      return require("@stll/anonymize-darwin-arm64");
    } catch (cause) {
      throw nativeSidecarLoadError("@stll/anonymize-darwin-arm64", cause);
    }
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    try {
      return require("@stll/anonymize-darwin-x64");
    } catch (cause) {
      throw nativeSidecarLoadError("@stll/anonymize-darwin-x64", cause);
    }
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    try {
      return require("@stll/anonymize-linux-arm64-gnu");
    } catch (cause) {
      throw nativeSidecarLoadError("@stll/anonymize-linux-arm64-gnu", cause);
    }
  }
  if (process.platform === "linux" && process.arch === "x64") {
    try {
      return require("@stll/anonymize-linux-x64-gnu");
    } catch (cause) {
      throw nativeSidecarLoadError("@stll/anonymize-linux-x64-gnu", cause);
    }
  }
  if (process.platform === "win32" && process.arch === "x64") {
    try {
      return require("@stll/anonymize-win32-x64-msvc");
    } catch (cause) {
      throw nativeSidecarLoadError("@stll/anonymize-win32-x64-msvc", cause);
    }
  }
  throw new Error(
    `No native anonymize binding is published for ${process.platform}-${process.arch}`,
  );
};

const nativeSidecarLoadError = (packageName, cause) =>
  new Error(
    `Failed to load native anonymize sidecar ${packageName}: ${causeMessage(cause)}`,
    { cause },
  );

const causeMessage = (cause) =>
  cause instanceof Error ? cause.message : String(cause);
