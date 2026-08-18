import { describe, it, expect, vi } from "vitest";
import { readCappedBody, PayloadTooLargeError } from "../../src/lib/capped-body.js";

function makeResponse(chunks: Uint8Array[], contentLength?: number, onCancel = vi.fn()) {
  let i = 0;
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-length" && contentLength !== undefined
          ? String(contentLength)
          : null,
    },
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
        cancel: onCancel,
      }),
    },
  } as unknown as Response;
}

describe("readCappedBody", () => {
  it("returns the whole body when it fits", async () => {
    const res = makeResponse([new Uint8Array([1, 2]), new Uint8Array([3])]);

    const buf = await readCappedBody(res, 1024);

    expect([...buf]).toEqual([1, 2, 3]);
  });

  it("refuses on a declared content-length over the limit, before reading anything", async () => {
    const cancel = vi.fn();
    const res = makeResponse([new Uint8Array(10)], 5_000_000, cancel);

    await expect(readCappedBody(res, 1024)).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("aborts mid-stream when an undeclared body crosses the limit", async () => {
    const cancel = vi.fn();
    const res = makeResponse([new Uint8Array(600), new Uint8Array(600), new Uint8Array(600)], undefined, cancel);

    const err = await readCappedBody(res, 1000).catch((e) => e);

    expect(err).toBeInstanceOf(PayloadTooLargeError);
    expect(err.limitBytes).toBe(1000);
    expect(err.observedBytes).toBe(1200);
    // The download is cancelled rather than drained, so the rest never allocates.
    expect(cancel).toHaveBeenCalled();
  });

  it("accepts a body exactly at the limit", async () => {
    const res = makeResponse([new Uint8Array(1000)]);

    const buf = await readCappedBody(res, 1000);

    expect(buf.byteLength).toBe(1000);
  });
});
