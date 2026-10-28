import { describe, it, expect, vi, afterEach } from "vitest";
import { readXlsxRows } from "../readXlsxRows";

type Reply = { rows?: unknown[][]; error?: string } | "crash";

function stubWorker(reply: Reply) {
  const terminate = vi.fn();
  const posted: unknown[] = [];
  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: { message: string }) => void) | null = null;
    terminate = terminate;
    postMessage(data: unknown) {
      posted.push(data);
      queueMicrotask(() => {
        if (reply === "crash") this.onerror?.({ message: "boom" });
        else this.onmessage?.({ data: reply });
      });
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
  return { terminate, posted };
}

describe("readXlsxRows", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the file to the worker and resolves its rows", async () => {
    const { terminate, posted } = stubWorker({ rows: [["user_id"], ["u-1"]] });
    const file = new File(["x"], "roles.xlsx");
    await expect(readXlsxRows(file)).resolves.toEqual([["user_id"], ["u-1"]]);
    expect(posted).toEqual([file]);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects with the worker's parse error or crash message", async () => {
    stubWorker({ error: "invalid zip" });
    await expect(readXlsxRows(new File(["x"], "bad.xlsx"))).rejects.toThrow("invalid zip");

    const { terminate } = stubWorker("crash");
    await expect(readXlsxRows(new File(["x"], "bad.xlsx"))).rejects.toThrow("boom");
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
