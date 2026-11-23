# The pinned local OCR models, alone. The `models` build context is the
# directory apps/api/src/scripts/fetch-ocr-models.ts downloaded and verified
# them into.
FROM scratch
COPY --from=models *.onnx /
