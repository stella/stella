declare const index: number;
declare const prefix: string;
declare const anchorId: string;

// oxlint-disable-next-line no-template-block-anchor/no-template-block-anchor -- Positive regression fixture for hand-minted positional anchors.
export const paragraph = `p-${String(index)}`;

// oxlint-disable-next-line no-template-block-anchor/no-template-block-anchor -- Positive regression fixture for a prefixed opinion anchor.
export const opinion = `${prefix}-h${String(index)}`;

// expect-clean: no-template-block-anchor/no-template-block-anchor
export const publisherPoint = `point${String(index)}`;

// expect-clean: no-template-block-anchor/no-template-block-anchor
export const prefixed = `${prefix}${anchorId}`;
