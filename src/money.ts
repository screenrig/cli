/** One mcr is a ten-millionth of a US dollar: 10,000,000 mcr is $1. */
export const MCR_PER_DOLLAR = 10_000_000n;

/**
 * An exact mcr amount (an integer string, as the API sends money) as US dollars
 * for a person: "$12.50", "-$0.015". It never rounds: at least two decimals, at
 * most seven, trailing zeros past the second dropped. Anything that is not an
 * integer string is undefined, so a caller never prints a guess.
 */
export function formatMcrAsDollars(value: unknown): string | undefined {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^-?[0-9]+$/.test(text)) return undefined;
  const mcr = BigInt(text);
  const negative = mcr < 0n;
  const abs = negative ? -mcr : mcr;
  const whole = (abs / MCR_PER_DOLLAR).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let fraction = (abs % MCR_PER_DOLLAR).toString().padStart(7, "0");
  while (fraction.length > 2 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${negative ? "-" : ""}$${whole}.${fraction}`;
}

/** The name a money member shows under in human output: `foo_mcr` shows as `foo`, in dollars. */
export function moneyLabel(field: string): string {
  return field.endsWith("_mcr") ? field.slice(0, -"_mcr".length) : field;
}
