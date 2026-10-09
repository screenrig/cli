export const ExitCode = {
  Success: 0,
  Unexpected: 1,
  Usage: 2,
  Auth: 3,
  NotFound: 4,
  Conflict: 5,
  Precondition: 6,
  RateLimited: 7,
  Client: 8,
  Server: 9,
  Network: 10,
  Timeout: 11,
  Config: 12,
  OperationFailed: 13,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export function exitCodeForStatus(status: number): ExitCode {
  if (status === 401 || status === 403) {
    return ExitCode.Auth;
  }
  if (status === 404) {
    return ExitCode.NotFound;
  }
  if (status === 409) {
    return ExitCode.Conflict;
  }
  if (status === 412) {
    return ExitCode.Precondition;
  }
  if (status === 408 || status === 504) {
    return ExitCode.Timeout;
  }
  if (status === 429) {
    return ExitCode.RateLimited;
  }
  if (status >= 400 && status < 500) {
    return ExitCode.Client;
  }
  if (status >= 500) {
    return ExitCode.Server;
  }
  return ExitCode.Unexpected;
}

/**
 * RFC 6749 errors from /oauth/token, /oauth/device_authorization and
 * /oauth/revoke, mapped by error code, never by status. authorization_pending
 * and slow_down are not problems: a device login keeps polling.
 */
export interface OAuthProblemRow {
  code: string;
  title: string;
  exitCode: ExitCode;
  next?: { command: string; reason: string };
}

const SIGN_IN_AGAIN = { command: "screenrig login", reason: "Sign this installation in again; a person approves it in the dashboard." };

export const OAUTH_PROBLEMS: Readonly<Record<string, OAuthProblemRow>> = {
  invalid_grant: { code: "session_ended", title: "Session ended", exitCode: ExitCode.Auth, next: SIGN_IN_AGAIN },
  invalid_client: { code: "client_auth_failed", title: "Client authentication failed", exitCode: ExitCode.Auth },
  invalid_request: { code: "invalid_request", title: "Invalid request", exitCode: ExitCode.Client },
  invalid_scope: {
    code: "insufficient_access", title: "Insufficient access", exitCode: ExitCode.Auth,
    next: { command: "screenrig login --access manage", reason: "Ask a person to approve Manage access for this project." },
  },
  invalid_target: { code: "invalid_request", title: "Invalid request", exitCode: ExitCode.Client },
  unauthorized_client: { code: "client_not_allowed", title: "Client not allowed", exitCode: ExitCode.Auth },
  unsupported_grant_type: { code: "client_not_allowed", title: "Client not allowed", exitCode: ExitCode.Auth },
  access_denied: { code: "login_denied", title: "Sign-in denied", exitCode: ExitCode.Auth },
  expired_token: { code: "login_expired", title: "Sign-in expired", exitCode: ExitCode.Timeout, next: SIGN_IN_AGAIN },
  temporarily_unavailable: { code: "service_unavailable", title: "Service unavailable", exitCode: ExitCode.Server },
  rate_limited: { code: "rate_limited", title: "Rate limited", exitCode: ExitCode.RateLimited },
};
