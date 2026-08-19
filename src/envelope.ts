export interface ProblemNext {
  command: string;
  reason: string;
}

export interface NormalizedProblem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code: string;
  request_id?: string;
  operation_id?: string;
  current_revision?: number;
  /** Present only on 429, taken from the server's Retry-After header. */
  retry_after_seconds?: number;
  errors: unknown[];
  next?: ProblemNext;
}

export interface Warning {
  code: string;
  message: string;
}

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  request_id?: string;
  operation_id?: string;
  warnings: Warning[];
}

export interface ErrorEnvelope {
  ok: false;
  error: NormalizedProblem;
  warnings?: Warning[];
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function successEnvelope<T>(
  data: T,
  extras?: { request_id?: string; operation_id?: string; warnings?: Warning[] },
): SuccessEnvelope<T> {
  return {
    ok: true,
    data,
    request_id: extras?.request_id,
    operation_id: extras?.operation_id,
    warnings: extras?.warnings ?? [],
  };
}

export function errorEnvelope(error: NormalizedProblem, extras?: { warnings?: Warning[] }): ErrorEnvelope {
  const warnings = extras?.warnings ?? [];
  return warnings.length > 0 ? { ok: false, error, warnings } : { ok: false, error };
}
