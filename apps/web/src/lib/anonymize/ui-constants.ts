/**
 * UI-specific constants for the anonymisation feature.
 * These are browser/React-only and not part of the
 * `@stella/anonymize` package.
 */

/**
 * GLiNER model option for the UI selector.
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

/**
 * Colour classes for entity highlights (Tailwind).
 * Keyed by canonical label.
 */
export const ENTITY_COLORS: Record<string, string> = {
  person: "bg-blue-200 dark:bg-blue-800",
  organization: "bg-green-200 dark:bg-green-800",
  "phone number": "bg-pink-200 dark:bg-pink-800",
  address: "bg-yellow-200 dark:bg-yellow-800",
  "email address": "bg-orange-200 dark:bg-orange-800",
  date: "bg-purple-200 dark:bg-purple-800",
  "bank account number": "bg-red-200 dark:bg-red-800",
  iban: "bg-red-200 dark:bg-red-800",
  "tax identification number": "bg-teal-200 dark:bg-teal-800",
  "identity card number": "bg-indigo-200 dark:bg-indigo-800",
  "registration number": "bg-cyan-200 dark:bg-cyan-800",
  "credit card number": "bg-rose-200 dark:bg-rose-800",
  "passport number": "bg-violet-200 dark:bg-violet-800",
};
