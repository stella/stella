// Structural teardown surface satisfied by pdfjs `PDFDocumentLoadingTask`.
// Keeping cleanup decoupled from the worker-bound pdfjs module lets it be
// unit-tested without pulling in the Vite `?worker&url` import graph.
type Destroyable = { destroy: () => Promise<void> };

export const destroyPDFDocument = async (data: {
  loadingTask: Destroyable;
  attachmentLoadingTasks: Destroyable[];
}) => {
  await Promise.all([
    data.loadingTask.destroy(),
    // oxlint requires promise-returning functions to be async (promise-function-async).
    ...data.attachmentLoadingTasks.map(async (task) => await task.destroy()),
  ]);
};
