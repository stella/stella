import { isFileProperty } from "@stll/api-contract/property-policy";

declare const content: { type: string };

// expect-clean: require-file-property-policy/require-file-property-policy
export const shared = isFileProperty(content);

// oxlint-disable-next-line require-file-property-policy/require-file-property-policy -- classification belongs to the shared policy
export const duplicated = content.type === "file";

// Type-level shapes do not classify runtime properties.
// expect-clean: require-file-property-policy/require-file-property-policy
export type FileContent = { type: "file" };
