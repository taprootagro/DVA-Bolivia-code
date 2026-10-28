import readXlsxFile from "read-excel-file/web-worker";

self.onmessage = (event: MessageEvent<File>) => {
  readXlsxFile(event.data).then(
    (rows) => self.postMessage({ rows }),
    (err: unknown) => self.postMessage({ error: err instanceof Error ? err.message : String(err) }),
  );
};
