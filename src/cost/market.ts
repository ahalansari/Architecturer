/**
 * Researched market rates (Kuwait, KWD) with provenance: every value carries the source it was taken from, the
 * quoted price text, the date it was read and a confidence. Generated from online research (see
 * docs/COST_RATES.md); refresh by re-running the research and regenerating market_kw.ts.
 */
import { MARKET_KW } from "./market_kw.js";

export interface MarketRate {
  key: string;
  value: number | null;
  low?: number | null;
  high?: number | null;
  unit: string;
  /** supply+install | supply | labour | percent | benchmark */
  basis: string;
  source: string;
  url: string;
  quote?: string;
  accessed: string;
  confidence: "high" | "medium" | "low" | string;
  note?: string;
}

const byKey = new Map<string, MarketRate>();
for (const r of MARKET_KW as MarketRate[]) if (r.value !== null && r.value !== undefined && !byKey.has(r.key)) byKey.set(r.key, r);

export function marketRate(key: string): MarketRate | undefined {
  return byKey.get(key);
}
export function marketRates(): MarketRate[] {
  return [...byKey.values()];
}
