/**
 * Bounded reading of a remote HTTP body.
 *
 * `Buffer.from(await response.arrayBuffer())` is unbounded: the whole remote
 * resource lands in memory before any size is known, so a large source video is
 * a heap-limit fatal rather than an error the caller can read. This reads the
 * body in chunks against a hard ceiling and aborts the download the moment the
 * ceiling is crossed.
 */
export class PayloadTooLargeError extends Error {
  constructor(
    readonly limitBytes: number,
    readonly observedBytes: number,
    readonly declared: boolean
  ) {
    super(
      `Payload exceeds the ${limitBytes} byte limit ` +
        `(${declared ? "declared" : "read"} ${observedBytes} bytes)`
    );
    this.name = "PayloadTooLargeError";
  }
}

export async function readCappedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PayloadTooLargeError(maxBytes, declared, true);
  }

  const body = response.body;
  if (!body) {
    throw new Error("Response has no body to read");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError(maxBytes, total, false);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}
