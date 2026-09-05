export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface TransportRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  json?: boolean;
  /** Read the response as bytes. Success bodies stay off `rawText`. */
  binary?: boolean;
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

export interface TransportByteStream {
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
  /** Release an unused response, including before iteration starts. */
  cancel?: () => Promise<void>;
}

export interface TransportDownloadResponse {
  status: number;
  headers: Record<string, string>;
  /** Present only for successful responses with a body. */
  body?: TransportByteStream;
  /** Parsed problem body for unsuccessful responses. */
  problem?: unknown;
  rawText?: string;
}

export interface Transport {
  request(req: TransportRequest): Promise<TransportResponse>;
  stream(req: TransportRequest): Promise<TransportStream>;
  download(req: TransportRequest): Promise<TransportDownloadResponse>;
}
