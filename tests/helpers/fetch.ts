export interface FetchCall {
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
  redirect: RequestInit['redirect'];
}

type Reply = Response | Error | ((signal: AbortSignal) => Response);

/** Fake fetch answering queued replies in order. An Error is thrown (network failure); a function gets the signal. */
export function fakeFetch(...replies: Reply[]): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: new URL(input instanceof Request ? input.url : String(input)),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
      redirect: init?.redirect,
    });
    const next = replies.shift();
    if (next === undefined) throw new Error('fakeFetch: unexpected request');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(init?.signal ?? new AbortController().signal) : next;
  };
  return { fetch: fetchImpl, calls };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Headers arrive, then the body stalls until the request signal aborts (timeout during body read). */
export function stallingBody(signal: AbortSignal): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"total":'));
      signal.addEventListener('abort', () => controller.error(signal.reason));
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Streams `size` bytes without content-length, recording whether the reader cancelled the stream. */
export function hugeStream(size: number): { response: Response; cancelled: () => boolean } {
  let sent = 0;
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) return controller.close();
      const chunk = new Uint8Array(Math.min(1024, size - sent)).fill(0x61);
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      wasCancelled = true;
    },
  });
  return { response: new Response(stream, { status: 200 }), cancelled: () => wasCancelled };
}

/** TypeError('fetch failed') carrying a system error code, like undici. */
export function networkError(code: string, message = 'fetch failed'): TypeError {
  return Object.assign(new TypeError(message), { cause: Object.assign(new Error(`connect ${code}`), { code }) });
}
