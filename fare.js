// Pure logic (no Firebase imports) so it can be unit-tested in Node.
export const DEFAULT_SETTINGS = {
  vehicles: {
    mini:  { label: 'Mini',  seats: 4, base: 50,  perKm: 14, minFare: 80,  mileage: 16, maintPerKm: 1.5,  hourly: 200, fullDay: 1800 },
    sedan: { label: 'Sedan', seats: 4, base: 70,  perKm: 17, minFare: 110, mileage: 13, maintPerKm: 2,    hourly: 250, fullDay: 2200 },
    suv:   { label: 'SUV',   seats: 6, base: 100, perKm: 22, minFare: 150, mileage: 10, maintPerKm: 2.75, hourly: 350, fullDay: 3000 }
  },
  waitFreeMin: 5, waitPerMin: 2, commissionPct: 10, fuelPrice: 105,
  airportSurcharge: 100, outstationPerKmMult: 1, outstationMinKm: 40,
  dispatchRadiusKm: 5, offerTimeoutMin: 25, expenseKmPerHour: 15
};
export const SERVICES = { city: 'City ride', airport: 'Airport transfer', outstation: 'Outstation', hourly: 'Hourly rental', fullday: 'Full-day rental' };
export const VEHICLES = ['mini', 'sedan', 'suv'];
export const NEEDS_DEST = s => ['city', 'airport', 'outstation'].includes(s);

export function mergeSettings(saved = {}) {
  const d = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const k of Object.keys(saved)) {
    if (k === 'vehicles') for (const v of VEHICLES) Object.assign(d.vehicles[v], saved.vehicles?.[v] || {});
    else if (k in d) d[k] = saved[k];
  }
  return d;
}
export function haversineKm(a, b) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Estimated fare (rupees). distanceKm must be the ROAD distance from the routing provider.
export function calcFare(s, vehicle, service, { distanceKm = 0, hours = 1 } = {}) {
  const v = s.vehicles[vehicle];
  if (!v) throw new Error('Unknown vehicle');
  let fare;
  if (service === 'hourly') fare = v.hourly * Math.max(1, hours);
  else if (service === 'fullday') fare = v.fullDay;
  else {
    let km = distanceKm, rate = v.perKm;
    if (service === 'outstation') { km = Math.max(km, s.outstationMinKm); rate *= s.outstationPerKmMult; }
    fare = Math.max(v.minFare, v.base + rate * km);
    if (service === 'airport') fare += s.airportSurcharge;
  }
  return Math.round(fare);
}
export const waitingCharge = (s, minutes) => Math.round(Math.max(0, minutes - s.waitFreeMin) * s.waitPerMin);
export function expenseKm(s, service, distanceKm, hours) {
  if (service === 'hourly') return hours * s.expenseKmPerHour;
  if (service === 'fullday') return 12 * s.expenseKmPerHour;
  return distanceKm || 0;
}
const r2 = n => Math.round(n * 100) / 100;
export function calcEarnings(s, vehicle, fare, km, other = 0) {
  const v = s.vehicles[vehicle];
  const commission = r2(fare * s.commissionPct / 100);
  const payout = r2(fare - commission);
  const fuel = r2(km / v.mileage * s.fuelPrice);
  const maint = r2(km * v.maintPerKm);
  const profit = r2(payout - fuel - maint - other);
  return { commission, payout, fuel, maint, other, profit };
}
export const TRANSITIONS = {
  PENDING: ['SEARCHING_DRIVER', 'CANCELLED'],
  SEARCHING_DRIVER: ['DRIVER_ASSIGNED', 'CANCELLED', 'NO_DRIVER_AVAILABLE'],
  DRIVER_ASSIGNED: ['DRIVER_ARRIVED', 'CANCELLED'],
  DRIVER_ARRIVED: ['TRIP_STARTED', 'CANCELLED'],
  TRIP_STARTED: ['TRIP_COMPLETED'],
  TRIP_COMPLETED: [], CANCELLED: [], NO_DRIVER_AVAILABLE: []
};
export const canTransition = (a, b) => (TRANSITIONS[a] || []).includes(b);
