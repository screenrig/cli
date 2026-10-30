export interface ProblemNext {
  command: string;
  reason: string;
  /** Arguments excluding the executable; avoids shell quoting ambiguity. */
  argv?: string[];
  /** Conditional template: inspect and reconcile before replacing placeholders. */
  after_inspection?: { command: string; argv: string[]; reason: string };
}

export interface NormalizedProblem {
  type: string;
  title: string;
  status: number;
  detail: string;
  /** One or two plain sentences telling the caller what to do next. */
  hint?: string;
  instance?: string;
  code: string;
  request_id?: string;
  /** Server trace correlation, when the server sent one. */
  trace_id?: string;
  operation_id?: string;
  current_revision?: number;
  /** insufficient_access only: the cap that held the credential to Propose. */
  access_limited_by?: "project" | "person";
  /** outside_upload_scope only: the playlists and media folders this uploader works in. */
  upload_scope?: { playlist_ids: string[]; folder_ids: string[]; access?: "propose" | "manage" };
  /** outside_screen_scope only: the screen folders and screens the caller works on. */
  screen_scope?: { folder_ids: string[]; screen_ids: string[] };
  /** feature_not_in_plan only: the plan feature the project's plan does not include. */
  feature?: string;
  /** feature_not_in_plan only: the project's plan. */
  plan?: string;
  /** feature_not_in_plan, member_limit_reached and quota_exceeded: the lowest plan that lifts the refusal. */
  required_plan?: string;
  /** Server 5xx only: whether retrying the unchanged request may succeed. */
  retryable?: boolean;
  /** Present only on 429, taken from the server's Retry-After header. */
  retry_after_seconds?: number;
  errors: unknown[];
  next?: ProblemNext;
}

export interface Warning {
  code: string;
  message: string;
  /** Present on `log_sink_degraded`: count of operation-log lines that were dropped. */
  dropped?: number;
}

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  request_id?: string;
  operation_id?: string;
  warnings: Warning[];
  context?: import("./project-context.js").ResultContext;
}

export interface ErrorEnvelope {
  ok: false;
  error: NormalizedProblem;
  warnings?: Warning[];
  context?: import("./project-context.js").ResultContext;
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
