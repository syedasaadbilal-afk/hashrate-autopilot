/**
 * Unit conversions for NiceHash's hashpower marketplace pricing.
 *
 * NiceHash prices and speed limits are denominated in BTC per
 * "marketFactor unit" of speed, per day - where marketFactor is the
 * algorithm's H/s-per-unit (GET /main/api/v2/mining/algorithms/, field
 * `marketFactor`). This differs from Braiins, which always prices in
 * sat/EH/day (see @hashrate-autopilot/shared's units.ts) - NiceHash's unit
 * varies per algorithm (SHA256's marketFactor corresponds to TH/s), so
 * every conversion here takes `marketFactor` as an explicit argument rather
 * than assuming a fixed unit. Deriving from live algorithm metadata avoids
 * hardcoding an assumption that could be wrong for a given algorithm.
 */

import { SAT_PER_BTC } from '@hashrate-autopilot/shared';

const H_PER_PH = 1e15;
const H_PER_EH = 1e18;

/** BTC-per-marketFactor-unit-per-day -> sat/PH/day. */
export function priceToSatPerPhDay(priceBtcPerUnitPerDay: number, marketFactor: number): number {
  const phPerUnit = marketFactor / H_PER_PH;
  return (priceBtcPerUnitPerDay / phPerUnit) * SAT_PER_BTC;
}

/** BTC-per-marketFactor-unit-per-day -> sat/EH/day (the rest of the daemon's native unit). */
export function priceToSatPerEhDay(priceBtcPerUnitPerDay: number, marketFactor: number): number {
  const ehPerUnit = marketFactor / H_PER_EH;
  return (priceBtcPerUnitPerDay / ehPerUnit) * SAT_PER_BTC;
}

/** sat/PH/day -> BTC-per-marketFactor-unit-per-day (inverse of {@link priceToSatPerPhDay}). */
export function satPerPhDayToPrice(satPerPhDay: number, marketFactor: number): number {
  const phPerUnit = marketFactor / H_PER_PH;
  return (satPerPhDay / SAT_PER_BTC) * phPerUnit;
}

/**
 * NiceHash accepts at most 4 decimal places on a submitted price, rejecting
 * anything finer with API error 2997 ("Price data can contain only up to 4
 * digits to the right of the decimal point!"). In BTC-per-display-unit-per-day
 * that's a 0.0001 tick - for the SHA-256 EH market, 0.0001 BTC/EH/day == 10
 * sat/PH/day. Round every price we submit (CREATE / EDIT_PRICE) to that tick so
 * a target like 48,199 sat/PH/day (-> 0.48199, five decimals) doesn't 2997 and
 * silently leave the order un-updated. Rounding to the nearest tick keeps a
 * decrease a decrease and an increase an increase (the daemon's own step/cap
 * logic works in >= 10 sat/PH/day moves).
 */
export const NICEHASH_PRICE_MAX_DECIMALS = 4;
export function roundToNicehashPriceTick(
  priceBtcPerUnitPerDay: number,
  decimals: number = NICEHASH_PRICE_MAX_DECIMALS,
): number {
  const f = Math.pow(10, decimals);
  return Math.round(priceBtcPerUnitPerDay * f) / f;
}

/** sat/EH/day -> BTC-per-marketFactor-unit-per-day (inverse of {@link priceToSatPerEhDay}). */
export function satPerEhDayToPrice(satPerEhDay: number, marketFactor: number): number {
  const ehPerUnit = marketFactor / H_PER_EH;
  return (satPerEhDay / SAT_PER_BTC) * ehPerUnit;
}

/** Speed in marketFactor units -> PH/s. */
export function speedUnitsToPh(speedUnits: number, marketFactor: number): number {
  return (speedUnits * marketFactor) / H_PER_PH;
}

/** PH/s -> speed in marketFactor units. */
export function phToSpeedUnits(ph: number, marketFactor: number): number {
  return (ph * H_PER_PH) / marketFactor;
}
