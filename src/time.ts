/** Injected clock: core logic never calls `new Date()` directly, so tests control time. */
export interface Clock {
  now(): Date;
}

export class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  set(d: Date): void {
    this.current = new Date(d);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Calendar date ("2026-11-15") as seen in the office's own time zone. */
export function localDate(d: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Budget month ("2026-11") as seen in the office's own time zone. */
export function localMonth(d: Date, timeZone: string): string {
  return localDate(d, timeZone).slice(0, 7);
}
