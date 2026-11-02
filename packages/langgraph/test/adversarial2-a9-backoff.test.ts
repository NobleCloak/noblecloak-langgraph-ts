/** A9: a stream that opens and closes at once does not reset the backoff, so it is not reconnected (and reconciled) every `backoffMs`. */
import { describe, expect, it } from 'vitest';

import { runResumer } from '../src/worker.js';
import { world, ours } from './foreign.js';
import { controlledStream, sleep, until } from './wait.js';

const STREAM = '/v1/approvals/stream';

describe('A9: reconnect backoff', () => {
  it('a server that accepts the stream and closes it at once is reconnected at growing intervals', async () => {
    const { h, agent } = await world();
    const opened: number[] = [];
    let listings = 0;
    h.intercept = (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/approvals' && request.method === 'GET') listings += 1;
      if (path !== STREAM) return undefined;
      opened.push(Date.now());
      return new Response('', { headers: { 'content-type': 'text/event-stream' } });
    };
    const worker = await runResumer(agent, {
      governance: ours(h),
      reconcileIntervalMs: 0,
      backoffMs: 50,
      maxBackoffMs: 800,
    });
    // Waits 50, 100, 200, 400: wait for five opens rather than a fixed window, so a loaded machine only slows the test.
    await until(() => opened.length >= 5);
    await worker.stop();
    // Each reconnect reconciles once (five states); a reset-every-open worker would list far more often per open.
    expect(listings).toBeLessThanOrEqual(opened.length * 6);
    // The fourth wait is 400 ms (50 doubled three times). A timer never fires early, so load can only lengthen the
    // gap; a worker that reset after every open would wait 50 ms. The first gap is not compared: it includes startup.
    const gaps = opened.slice(1).map((t, i) => t - (opened[i] ?? 0));
    expect(gaps[3] ?? 0).toBeGreaterThanOrEqual(350);
  });

  it('a stream that stayed open long enough starts the backoff over', async () => {
    const { h, agent } = await world();
    const opened: number[] = [];
    const closedAt: number[] = [];
    const streams: ReturnType<typeof controlledStream>[] = [];
    h.intercept = (request) => {
      if (new URL(request.url).pathname !== STREAM) return undefined;
      opened.push(Date.now());
      const n = opened.length;
      if (n <= 3) return new Response('', { headers: { 'content-type': 'text/event-stream' } });
      const stream = controlledStream();
      streams.push(stream);
      return stream.response();
    };
    const worker = await runResumer(agent, {
      governance: ours(h),
      reconcileIntervalMs: 0,
      backoffMs: 100,
      maxBackoffMs: 3200,
      streamStableMs: 20,
    });
    // Three immediate closes (waits 100, 200, 400), then the fourth stream stays open past `streamStableMs`.
    while (streams.length === 0) await sleep(10);
    // Well past `streamStableMs`: the worker measures the stream's age from after its reconcile, which load can delay.
    await sleep(400);
    closedAt.push(Date.now());
    streams[0]?.close();
    while (opened.length < 5) await sleep(5);
    await worker.stop();
    // The wait after the stable stream is the base (100 ms), not the 800 the doubling had reached; the bound
    // leaves 400 ms of scheduler slack for a loaded machine.
    expect((opened[4] ?? 0) - (closedAt[0] ?? 0)).toBeLessThan(500);
  });

  it('a stream that delivered an event starts the backoff over, however briefly it was open', async () => {
    const { h, agent } = await world();
    const opened: number[] = [];
    const streams: ReturnType<typeof controlledStream>[] = [];
    h.intercept = (request) => {
      if (new URL(request.url).pathname !== STREAM) return undefined;
      opened.push(Date.now());
      if (opened.length <= 3)
        return new Response('', { headers: { 'content-type': 'text/event-stream' } });
      const stream = controlledStream();
      streams.push(stream);
      return stream.response();
    };
    const worker = await runResumer(agent, {
      governance: ours(h),
      reconcileIntervalMs: 0,
      backoffMs: 100,
      maxBackoffMs: 3200,
      streamStableMs: 60_000,
    });
    while (streams.length === 0) await sleep(10);
    const at = Date.now();
    streams[0]?.push('event: approval.updated\ndata: {"id":"x","state":"pending"}\n\n');
    await sleep(10);
    streams[0]?.close();
    while (opened.length < 5) await sleep(5);
    await worker.stop();
    // Base wait is 100 ms; without the reset it would be 800. The bound leaves 400 ms of scheduler slack.
    expect((opened[4] ?? 0) - at).toBeLessThan(500);
  });
});
