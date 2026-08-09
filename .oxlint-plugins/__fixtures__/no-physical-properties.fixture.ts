// Passive regression fixture for `no-physical-properties/no-physical-properties`.

// oxlint-disable-next-line no-physical-properties/no-physical-properties -- fixture proves physical utilities in string literals are rejected
const physicalLiteral = "ml-2 text-left border-r";
// oxlint-disable-next-line no-physical-properties/no-physical-properties -- fixture proves template elements receive the same RTL guard
const physicalTemplate = `hover:pr-4 rounded-l-md`;

const logicalLiteral = "ms-2 text-start border-e";
const logicalTemplate = `hover:pe-4 rounded-s-md`;

export { logicalLiteral, logicalTemplate, physicalLiteral, physicalTemplate };
