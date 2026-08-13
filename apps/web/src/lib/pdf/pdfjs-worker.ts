import "@/lib/pdf/uint8array-to-hex-polyfill";
import "pdfjs-dist/build/pdf.worker.mjs";

// PDF.js dynamically imports workerSrc when a real worker cannot start. Vite
// strips worker-entry exports, so the worker-only build plugin restores the
// upstream WorkerMessageHandler export from its global registration.
