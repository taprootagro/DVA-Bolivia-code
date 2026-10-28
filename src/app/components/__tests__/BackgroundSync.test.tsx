import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { SyncQueueRecord } from "../../utils/db";

const loadSyncQueueMock = vi.fn();
const saveSyncQueueMock = vi.fn();

vi.mock("../../utils/db", () => ({
  loadSyncQueue: (...args: unknown[]) => loadSyncQueueMock(...args),
  saveSyncQueue: (...args: unknown[]) => saveSyncQueueMock(...args),
  addToSyncQueue: vi.fn(async () => {}),
}));

import { BackgroundSync } from "../BackgroundSync";

function record(id: string): SyncQueueRecord {
  return { id, type: "comment", data: "{}", timestamp: 1, status: "pending", retryCount: 0 };
}

function lastSavedStatuses(): Record<string, string> {
  const calls = saveSyncQueueMock.mock.calls;
  const last = calls[calls.length - 1]?.[0] as SyncQueueRecord[] | undefined;
  return Object.fromEntries((last ?? []).map((r) => [r.id, r.status]));
}

describe("BackgroundSync queue updates", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    loadSyncQueueMock.mockReset();
    saveSyncQueueMock.mockReset();
    saveSyncQueueMock.mockResolvedValue(undefined);
    loadSyncQueueMock.mockResolvedValue([record("a"), record("b")]);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    function FakeRegistration() {}
    FakeRegistration.prototype.sync = {};
    vi.stubGlobal("ServiceWorkerRegistration", FakeRegistration);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.reject(new Error("no sw")).catch(() => new Promise(() => {})) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  });

  it("keeps every item's result when several items sync in one pass", async () => {
    render(<BackgroundSync />);
    const button = await screen.findByRole("button", { name: /Sync now/ });
    await waitFor(() => expect(button).not.toBeDisabled());

    fireEvent.click(button);

    await waitFor(() => expect(lastSavedStatuses()).toEqual({ a: "success", b: "success" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("syncs the current queue when the network comes back", async () => {
    render(<BackgroundSync />);
    await screen.findByRole("button", { name: /Sync now/ });
    await waitFor(() => expect(loadSyncQueueMock).toHaveBeenCalled());
    await act(async () => {});

    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.reject(new Error("no sw")) },
    });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(lastSavedStatuses()).toEqual({ a: "success", b: "success" }));
  });
});
