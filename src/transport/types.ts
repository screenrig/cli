export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface TransportRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  json?: boolean;
  timeout_ms?: number;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  rawText?: string;
}

export interface TransportStream {
  [Symbol.asyncIterator](): AsyncIterator<string>;
}

export interface Transport {
  request(req: TransportRequest): Promise<TransportResponse>;
  stream(req: TransportRequest): Promise<TransportStream>;
}
