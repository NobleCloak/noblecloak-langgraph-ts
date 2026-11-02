/** Small helpers for tests that wait on a background loop. */

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Polls until `check` is true, or fails the test after `timeoutMs`. */
export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await sleep(15);
  }
}

/** An SSE response a test drives by hand. */
export function controlledStream(): {
  readonly response: () => Response;
  push(text: string): void;
  close(): void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(encoder.encode(': connected\n\n'));
    },
  });
  return {
    response: () =>
      new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      }),
    push: (text) => {
      controller?.enqueue(encoder.encode(text));
    },
    close: () => {
      controller?.close();
    },
  };
}

/** One `approval.updated` frame. */
export const frame = (data: unknown): string =>
  `event: approval.updated\ndata: ${JSON.stringify(data)}\n\n`;
