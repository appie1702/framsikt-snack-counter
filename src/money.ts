/**
 * Money is always an integer number of minor units (øre / paise) plus its currency.
 * Never a float: 0.1 + 0.2 must equal 0.30, and NOK must never be added to INR by accident.
 */
export type Currency = 'NOK' | 'INR';

export interface Money {
  readonly minor: number;
  readonly currency: Currency;
}

export function money(major: number, currency: Currency): Money {
  return ofMinor(Math.round(major * 100), currency);
}

export function ofMinor(minor: number, currency: Currency): Money {
  if (!Number.isSafeInteger(minor)) throw new Error(`Money must be an integer number of minor units, got ${minor}`);
  return { minor, currency };
}

export const zero = (currency: Currency): Money => ({ minor: 0, currency });

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return ofMinor(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return ofMinor(a.minor - b.minor, a.currency);
}

export function sum(items: Money[], currency: Currency): Money {
  return items.reduce(add, zero(currency));
}

/** Decimal string for external systems (e.g. HR API): "1234.50". */
export function toDecimalString(m: Money): string {
  const sign = m.minor < 0 ? '-' : '';
  const abs = Math.abs(m.minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function format(m: Money): string {
  return `${toDecimalString(m)} ${m.currency}`;
}
