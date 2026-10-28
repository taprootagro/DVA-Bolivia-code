import type { Row } from "read-excel-file/web-worker";

type WorkerReply = { rows?: Row[]; error?: string };

/** Parse an .xlsx file in a Web Worker so large role-import sheets don't freeze the CMS tab. */
export function readXlsxRows(file: File): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/readXlsx.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      worker.terminate();
      const { rows, error } = event.data;
      if (rows) resolve(rows);
      else reject(new Error(error || "xlsx worker failed"));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "xlsx worker failed"));
    };
    worker.postMessage(file);
  });
}
