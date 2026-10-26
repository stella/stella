// The original PDF view marks each drawn claim box with this attribute. It
// lives apart from the lazily loaded view so the verification view can ask
// whether a box is drawn without loading the PDF viewer.

export const PDF_CLAIM_BOX_ATTRIBUTE = "data-avt-claim";

/** Whether the original PDF has drawn a box for this claim right now. */
export const isPdfClaimBoxDrawn = (claimId: string): boolean =>
  document.querySelector(
    `[${PDF_CLAIM_BOX_ATTRIBUTE}="${CSS.escape(claimId)}"]`,
  ) !== null;
