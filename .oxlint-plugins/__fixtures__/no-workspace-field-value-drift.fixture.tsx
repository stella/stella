// Passive regression fixture for
// `no-workspace-field-value-drift/no-workspace-field-value-drift`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag;
// a regression makes them unused and CI fails. Lines without a directive
// cover the allow-list and must keep passing.

type WorkspaceFieldContent =
  | { type: "file"; fileName: string }
  | { type: "pending" }
  | { type: "text"; value: string }
  | { type: "date"; value: string | null }
  | { type: "int"; value: number }
  | { type: "single-select"; value: string | null }
  | { type: "multi-select"; value: string[] };

type WorkspaceProperty = {
  content: { type: "file" | "date" | "single-select" };
};

declare const field: { content: WorkspaceFieldContent };
declare const fieldContent: WorkspaceFieldContent | undefined;
declare const content: WorkspaceFieldContent;
declare const property: WorkspaceProperty;

export const _aliasBranch = () => {
  const type = field.content.type;

  // oxlint-disable-next-line no-workspace-field-value-drift/no-workspace-field-value-drift
  if (type === "date") {
    return null;
  }

  return <FieldValue content={field.content} property={property} />;
};

export const _directBranch = () => {
  // oxlint-disable-next-line no-workspace-field-value-drift/no-workspace-field-value-drift
  if (field.content.type === "int") {
    return null;
  }

  return <FieldValue content={field.content} property={property} />;
};

export const _optionalBranch = () => {
  // oxlint-disable-next-line no-workspace-field-value-drift/no-workspace-field-value-drift
  if (fieldContent?.type === "single-select") {
    return null;
  }

  return <FieldValue content={fieldContent} property={property} />;
};

export const _switchBranch = () => {
  switch (content.type) {
    // oxlint-disable-next-line no-workspace-field-value-drift/no-workspace-field-value-drift
    case "text":
      return null;
    case "file":
      return null;
    default:
      return <FieldValue content={content} property={property} />;
  }
};

// --- Allowed: file/pending branches drive routing/loading, not display drift ---

export const _fileBranch = () => {
  if (field.content.type === "file") {
    return <button type="button">{field.content.fileName}</button>;
  }

  return <FieldValue content={field.content} property={property} />;
};

export const _pendingBranch = () => {
  if (fieldContent?.type === "pending") {
    return <span>loading</span>;
  }

  return <FieldValue content={fieldContent} property={property} />;
};

export const _propertyTypeBranch = () => {
  if (property.content.type === "date") {
    return <span>date property</span>;
  }

  return null;
};

export const _rawBidiText = () => (
  // oxlint-disable-next-line no-workspace-field-value-drift/no-raw-field-value-bidi-text
  <div dir="auto">שלום v ABC-123</div>
);

export const _isolatedBidiText = () => (
  <BidiText as="div">שלום v ABC-123</BidiText>
);

const FieldValue = (_props: {
  content: WorkspaceFieldContent | undefined;
  property: WorkspaceProperty;
}) => null;

const BidiText = (_props: { as: "div"; children: string }) => null;
