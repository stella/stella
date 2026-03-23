/**
 * UI-specific constants for the anonymisation feature.
 * These are browser/React-only and not part of the
 * `@stella/anonymize` package.
 */

export type ModelOption = {
  id: string;
  label: string;
  url: string;
  tokenizer: string;
};

export const MODEL_OPTIONS: readonly ModelOption[] = [
  {
    id: "pii-fp16",
    label: "PII v1 (fp16, 580 MB)",
    url: "https://huggingface.co/onnx-community/gliner_multi_pii-v1/resolve/main/onnx/model_fp16.onnx",
    tokenizer: "onnx-community/gliner_multi_pii-v1",
  },
  {
    id: "pii-int8",
    label: "PII v1 (int8, 349 MB)",
    url: "https://huggingface.co/onnx-community/gliner_multi_pii-v1/resolve/main/onnx/model_quantized.onnx",
    tokenizer: "onnx-community/gliner_multi_pii-v1",
  },
  {
    id: "multi-v2.1-fp16",
    label: "Multi v2.1 (fp16, 580 MB)",
    url: "https://huggingface.co/onnx-community/gliner_multi-v2.1/resolve/main/onnx/model_fp16.onnx",
    tokenizer: "onnx-community/gliner_multi-v2.1",
  },
  {
    id: "multi-v2.1-int8",
    label: "Multi v2.1 (int8, 349 MB)",
    url: "https://huggingface.co/onnx-community/gliner_multi-v2.1/resolve/main/onnx/model_quantized.onnx",
    tokenizer: "onnx-community/gliner_multi-v2.1",
  },
  {
    id: "pii-edge",
    label: "PII Edge (fp32, ~170 MB)",
    url: "https://huggingface.co/knowledgator/gliner-pii-edge-v1.0/resolve/main/onnx/model.onnx",
    tokenizer: "onnx-community/gliner_multi_pii-v1",
  },
  {
    id: "pii-edge-fp16",
    label: "PII Edge (fp16, 91 MB)",
    url: "https://huggingface.co/knowledgator/gliner-pii-edge-v1.0/resolve/main/onnx/model_fp16.onnx",
    tokenizer: "onnx-community/gliner_multi_pii-v1",
  },
];

// ── Entity colours ───────────────────────────────────

type ColorTriple = [number, number, number];

type EntityColor = {
  /** Light fill (0–1 sRGB), same values as PDF redaction */
  fill: ColorTriple;
  /** Medium border (0–1 sRGB) */
  border: ColorTriple;
  /** Dark text (0–1 sRGB) */
  text: ColorTriple;
};

const FALLBACK_COLOR: EntityColor = {
  fill: [0.9, 0.9, 0.9],
  border: [0.63, 0.63, 0.63],
  text: [0.25, 0.25, 0.25],
};

const ENTITY_COLORS: Record<string, EntityColor> = {
  person: {
    fill: [0.74, 0.83, 0.95],
    border: [0.38, 0.56, 0.83],
    text: [0.11, 0.29, 0.55],
  },
  organization: {
    fill: [0.73, 0.91, 0.78],
    border: [0.29, 0.73, 0.4],
    text: [0.08, 0.4, 0.15],
  },
  "phone number": {
    fill: [0.98, 0.76, 0.83],
    border: [0.96, 0.45, 0.58],
    text: [0.74, 0.12, 0.24],
  },
  address: {
    fill: [0.99, 0.93, 0.7],
    border: [0.98, 0.82, 0.2],
    text: [0.63, 0.49, 0.04],
  },
  "email address": {
    fill: [0.99, 0.84, 0.69],
    border: [0.98, 0.58, 0.24],
    text: [0.77, 0.33, 0.01],
  },
  date: {
    fill: [0.91, 0.8, 0.94],
    border: [0.75, 0.52, 0.81],
    text: [0.43, 0.18, 0.52],
  },
  "bank account number": {
    fill: [0.99, 0.79, 0.79],
    border: [0.97, 0.45, 0.45],
    text: [0.72, 0.11, 0.11],
  },
  iban: {
    fill: [0.99, 0.79, 0.79],
    border: [0.97, 0.45, 0.45],
    text: [0.72, 0.11, 0.11],
  },
  "tax identification number": {
    fill: [0.6, 0.92, 0.9],
    border: [0.18, 0.71, 0.67],
    text: [0.05, 0.37, 0.35],
  },
  "identity card number": {
    fill: [0.78, 0.78, 0.97],
    border: [0.5, 0.5, 0.91],
    text: [0.23, 0.23, 0.6],
  },
  "registration number": {
    fill: [0.65, 0.93, 0.97],
    border: [0.13, 0.78, 0.85],
    text: [0.06, 0.41, 0.45],
  },
  "credit card number": {
    fill: [1, 0.79, 0.82],
    border: [0.98, 0.44, 0.52],
    text: [0.74, 0.12, 0.21],
  },
  "passport number": {
    fill: [0.87, 0.82, 0.95],
    border: [0.66, 0.55, 0.87],
    text: [0.36, 0.25, 0.6],
  },
  "czech birth number": {
    fill: [0.98, 0.76, 0.83],
    border: [0.96, 0.45, 0.58],
    text: [0.74, 0.12, 0.24],
  },
};

/** Normalized sRGB triple (0–1 per channel) to a CSS `rgb()` color string. */
export const normalizedSrgbTripleToCss = (triple: ColorTriple): string => {
  const [r, g, b] = triple;
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
};

/** RGB triples for PDF redaction export and UI overlays. */
export const getEntityPDFColors = (
  label: string,
): { fill: ColorTriple; border: ColorTriple; text: ColorTriple } => {
  const c = ENTITY_COLORS[label] ?? FALLBACK_COLOR;
  return { fill: c.fill, border: c.border, text: c.text };
};

/** CSS `rgb()` fill colour for the entity (matches PDF redaction). */
export const getEntityColor = (label: string): string =>
  normalizedSrgbTripleToCss(getEntityPDFColors(label).fill);
