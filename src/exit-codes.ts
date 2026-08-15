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
