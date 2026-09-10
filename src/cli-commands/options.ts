import { quotedRevision } from "../if-match.js";
import { usageError } from "../problems.js";

export function nonnegativeInteger(name: string): (value: string) => string {
  return (value) => {
    const number = Number(value);
    if (!value.trim() || !Number.isSafeInteger(number) || number < 0) {
      throw usageError(`--${name} requires a nonnegative whole number.`);
    }
    return value;
  };
}

export function positiveInteger(name: string): (value: string) => string {
  const parse = nonnegativeInteger(name);
  return (value) => {
    parse(value);
    if (Number(value) === 0) throw usageError(`--${name} must be greater than zero.`);
    return value;
  };
}

export function positiveNumber(name: string): (value: string) => string {
  return (value) => {
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number) || number < 0) {
      throw usageError(`--${name} requires a nonnegative number.`);
    }
    if (number === 0) throw usageError(`--${name} must be greater than zero.`);
    return value;
  };
}

export function toastDuration(value: string): string {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 2000 || number > 60000) {
    throw usageError("--duration-ms must be a whole number between 2000 and 60000.");
  }
  return value;
}

export function revision(value: string): string {
  quotedRevision(value);
  return value;
}
