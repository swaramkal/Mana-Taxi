import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS as S, calcFare, calcEarnings, waitingCharge, canTransition, haversineKm, mergeSettings } from '../public/js/fare.js';
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} != ${b}`);
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('mini 10km city = 50+14*10', () => assert.equal(calcFare(S, 'mini', 'city', { distanceKm: 10 }), 190));
t('sedan 3km city above minimum = 70+51', () => assert.equal(calcFare(S, 'sedan', 'city', { distanceKm: 3 }), 121));
t('suv 1km hits minimum 150', () => assert.equal(calcFare(S, 'suv', 'city', { distanceKm: 1 }), 150));
t('mini 0.5km hits minimum 80', () => assert.equal(calcFare(S, 'mini', 'city', { distanceKm: 0.5 }), 80));
t('airport adds surcharge', () => assert.equal(calcFare(S, 'mini', 'airport', { distanceKm: 10 }), 290));
t('outstation bills at least min km', () => assert.equal(calcFare(S, 'mini', 'outstation', { distanceKm: 10 }), 50 + 14 * 40));
t('hourly 3h sedan', () => assert.equal(calcFare(S, 'sedan', 'hourly', { hours: 3 }), 750));
t('full day suv', () => assert.equal(calcFare(S, 'suv', 'fullday', {}), 3000));
t('waiting: 5 min free, then Rs2/min', () => { assert.equal(waitingCharge(S, 5), 0); assert.equal(waitingCharge(S, 9), 8); });
t('earnings mini 190 / 10km', () => {
  const e = calcEarnings(S, 'mini', 190, 10, 0);
  near(e.commission, 19); near(e.payout, 171); near(e.fuel, 65.63); near(e.maint, 15); near(e.profit, 90.38);
});
t('earnings subtract other expenses', () => near(calcEarnings(S, 'suv', 300, 10, 20).profit, 270 - 105 - 27.5 - 20));
t('admin-edited settings merge', () => { const m = mergeSettings({ commissionPct: 15, vehicles: { mini: { perKm: 20 } } }); assert.equal(m.commissionPct, 15); assert.equal(m.vehicles.mini.perKm, 20); assert.equal(m.vehicles.mini.base, 50); });
t('valid trip transitions only', () => {
  assert.ok(canTransition('SEARCHING_DRIVER', 'DRIVER_ASSIGNED')); assert.ok(canTransition('DRIVER_ARRIVED', 'TRIP_STARTED'));
  assert.ok(!canTransition('SEARCHING_DRIVER', 'TRIP_STARTED')); assert.ok(!canTransition('TRIP_COMPLETED', 'CANCELLED')); assert.ok(!canTransition('TRIP_STARTED', 'CANCELLED'));
});
t('haversine ~ Vizag RK Beach to airport', () => { const d = haversineKm({ lat: 17.7127, lng: 83.3236 }, { lat: 17.7212, lng: 83.2245 }); assert.ok(d > 9 && d < 12); });
console.log(`\n${n} tests passed`);
