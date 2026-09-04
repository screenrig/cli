import { CliError, networkError, normalizeProblem, timeoutError } from "../problems.js";
import type {
  Transport,
  TransportByteStream,
  TransportDownloadResponse,
  TransportRequest,
  TransportResponse,
  TransportStream,
} from "./types.js";

function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function decodeTextBody(text: string, contentType: string): unknown {
  if (text && (contentType.includes("json") || text.startsWith("{") || text.startsWith("["))) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text || undefined;
}

function buildUrl(base: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }
  return url.toString();
}

export class FetchTransport implements Transport {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(req: TransportRequest): Record<string, string> {
    const headers: Record<string, string> = {
      accept: req.binary ? "image/webp" : req.json === false ? "*/*" : "application/json",
      ...req.headers,
    };
    if (this.token && !headers.authorization) {
      headers.authorization = `Bearer ${this.token}`;
    }
    if (req.body !== undefined && headers["content-type"] === undefined) {
      headers["content-type"] =
        req.body instanceof Uint8Array ? "application/octet-stream" : "application/json";
    }
    return headers;
  }

  private serialize(body: unknown): Buffer | string | undefined {
    if (body === undefined) {
      return undefined;
    }
    if (body instanceof Uint8Array) {
      return Buffer.from(body);
    }
    if (typeof body === "string") {
      return body;
    }
    return JSON.stringify(body);
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    const controller = new AbortController();
    const signal = req.signal ? AbortSignal.any([req.signal, controller.signal]) : controller.signal;
    const timer =
      req.timeout_ms && req.timeout_ms > 0
        ? setTimeout(() => controller.abort(), req.timeout_ms)
        : undefined;
    try {
      const response = await this.fetchImpl(buildUrl(this.apiUrl, req.path, req.query), {
        method: req.method,
        headers: this.headers(req),
        body: this.serialize(req.body),
        signal,
      });
      const headers = headerMap(response.headers);
      if (req.binary) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (response.status >= 400) {
          const text = new TextDecoder().decode(bytes);
          return { status: response.status, headers, body: decodeTextBody(text, headers["content-type"] ?? ""), rawText: text };
        }
        return { status: response.status, headers, body: bytes };
      }
      const text = await response.text();
      return { status: response.status, headers, body: decodeTextBody(text, headers["content-type"] ?? ""), rawText: text };
    } catch (err) {
      if (signal.aborted || (err as Error).name === "AbortError") {
        throw timeoutError("API request timed out", req.headers?.["x-request-id"]);
      }
      throw networkError(
        err instanceof Error ? err.message : "API request failed",
        req.headers?.["x-request-id"],
      );
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async stream(req: TransportRequest): Promise<TransportStream> {
    let response: Response;
    try {
      response = await this.fetchImpl(buildUrl(this.apiUrl, req.path, req.query), {
        method: req.method,
        headers: {
          ...this.headers(req),
          accept: "text/event-stream",
        },
        signal: req.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw timeoutError("SSE connection timed out", req.headers?.["x-request-id"]);
      }
      throw networkError(err instanceof Error ? err.message : "SSE connection failed", req.headers?.["x-request-id"]);
    }
    if (!response.ok || !response.body) {
      const text = await response.text();
      let body: unknown = text;
      try { body = JSON.parse(text) as unknown; } catch { /* Preserve the bounded fallback text. */ }
      throw new CliError(normalizeProblem(body, {
        status: response.status,
        request_id: response.headers.get("x-request-id") ?? req.headers?.["x-request-id"],
        bodyText: text.slice(0, 300),
      }));
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const requestId = req.headers?.["x-request-id"];
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            yield decoder.decode(value, { stream: true });
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") {
            throw err;
          }
          throw networkError(err instanceof Error ? err.message : "SSE stream failed", requestId);
        } finally {
          reader.releaseLock();
        }
      },
    };
  }

  async download(req: TransportRequest): Promise<TransportDownloadResponse> {
    const controller = new AbortController();
    const signal = req.signal ? AbortSignal.any([req.signal, controller.signal]) : controller.signal;
    const timer =
      req.timeout_ms && req.timeout_ms > 0
        ? setTimeout(() => controller.abort(), req.timeout_ms)
        : undefined;
    let response: Response;
    try {
      response = await this.fetchImpl(buildUrl(this.apiUrl, req.path, req.query), {
        method: req.method,
        headers: { ...this.headers(req), accept: "*/*" },
        signal,
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (signal.aborted || (err as Error).name === "AbortError") {
        throw timeoutError("Media download timed out", req.headers?.["x-request-id"]);
      }
      throw networkError(err instanceof Error ? err.message : "Media download failed", req.headers?.["x-request-id"]);
    }

    const headers = headerMap(response.headers);
    if (response.status >= 400) {
      try {
        const text = await response.text();
        return {
          status: response.status,
          headers,
          problem: decodeTextBody(text, headers["content-type"] ?? ""),
          rawText: text,
        };
      } catch (err) {
        if (signal.aborted || (err as Error).name === "AbortError") {
          throw timeoutError("Media download timed out", req.headers?.["x-request-id"]);
        }
        throw networkError(err instanceof Error ? err.message : "Media download failed", req.headers?.["x-request-id"]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (!response.body) {
      if (timer) clearTimeout(timer);
      return { status: response.status, headers };
    }

    const reader = response.body.getReader();
    const requestId = req.headers?.["x-request-id"];
    const body: TransportByteStream = {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            yield value;
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") throw timeoutError("Media download timed out", requestId);
          throw networkError(err instanceof Error ? err.message : "Media download stream failed", requestId);
        } finally {
          if (timer) clearTimeout(timer);
          reader.releaseLock();
        }
      },
    };
    return { status: response.status, headers, body };
  }
}
