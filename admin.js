
import {
  $, esc, inr, ms, fmtTime, toast, badge, STATUS, TERMINAL,
  initTheme, initNav, showConfigBanner, requireRole, loadSettings,
  audit, db,
  collection, doc, query, orderBy, limit, onSnapshot,
  updateDoc, setDoc, runTransaction, serverTimestamp
} from './common.js';

import { SERVICES, VEHICLES, haversineKm } from './fare.js';

initTheme();
initNav();
showConfigBanner();

let tab = 'overview';
let settings;
let users = [];
let drivers = [];
let bookings = [];
let tickets = [];
let filt = { q: '', st: '' };

const short = a => (a || '').split(',').slice(0, 2).join(',');
const sum = (rows, k) =>
  rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);

const done = () =>
  bookings.filter(b => b.status === 'TRIP_COMPLETED');

const isTerminal = status => TERMINAL.includes(status);

const safeParse = value => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

requireRole('admin', async () => {
  try {
    settings = await loadSettings();

    document.querySelectorAll('#tabs .tab').forEach(t => {
      t.onclick = () => {
        tab = t.dataset.p;

        document.querySelectorAll('#tabs .tab').forEach(x => {
          x.classList.toggle('on', x === t);
        });

        render();
      };
    });

    $('#dlgX').onclick = () => $('#dlg').close();

    const err = name => error => {
      console.error(`${name} listener error:`, error);
      toast(`${name}: ${error.message}`, 'error');
    };

    onSnapshot(
      collection(db, 'users'),
      snap => {
        users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        render();
      },
      err('Users')
    );

    onSnapshot(
      collection(db, 'drivers'),
      snap => {
        drivers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        render();
      },
      err('Drivers')
    );

    onSnapshot(
      query(
        collection(db, 'bookings'),
        orderBy('createdAt', 'desc'),
        limit(500)
      ),
      snap => {
        bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        render();
      },
      err('Bookings')
    );

    onSnapshot(
      collection(db, 'support'),
      snap => {
        tickets = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));

        render();
      },
      err('Support')
    );

    setInterval(() => {
      if (tab === 'dispatch') render();
    }, 5000);

  } catch (error) {
    console.error('Admin initialization failed:', error);
    toast('Could not initialize admin dashboard: ' + error.message, 'error');
  }
});

function render() {
  if (!settings) return;

  const view = $('#view');
  if (!view) return;

  // Preserve the current input while a user is typing.
  const active = document.activeElement;

  if (
    active &&
    view.contains(active) &&
    ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)
  ) {
    return;
  }

  const pages = {
    overview,
    customers,
    drivers: driversView,
    bookings: bookingsView,
    dispatch,
    fares,
    analytics,
    support
  };

  pages[tab]?.(view);
}

const stat = (number, label) =>
  `<div class="card stat"><b>${number}</b><span>${label}</span></div>`;

const act = (id, label, cls = '') =>
  `<button type="button" class="btn sm ${cls}" data-act="${id}">${label}</button>`;

function bind(view, handlers) {
  view.querySelectorAll('[data-act]').forEach(button => {
    button.onclick = () => {
      const [action, id] = button.dataset.act.split('|');
      handlers[action]?.(id, button);
    };
  });
}

async function safe(fn, successMessage) {
  try {
    await fn();

    if (successMessage) {
      toast(successMessage, 'success');
    }
  } catch (error) {
    console.error(error);
    toast(error.message || 'Action failed', 'error');
  }
}

function preserveSearch(renderFunction, view) {
  const input = $('#fq', view);
  if (!input) return;

  const start = input.selectionStart;
  const end = input.selectionEnd;

  renderFunction(view);

  const replacement = $('#fq', view);

  if (replacement) {
    replacement.focus();

    try {
      replacement.setSelectionRange(start, end);
    } catch {}
  }
}

/* ---------------- OVERVIEW ---------------- */

function overview(view) {
  const customersCount =
    users.filter(u => u.role === 'customer').length;

  const completed = done();

  view.innerHTML = `
    <div class="grid g4 keep2">
      ${stat(customersCount, 'Total customers')}
      ${stat(drivers.length, 'Total drivers')}
      ${stat(drivers.filter(d => d.approval === 'PENDING').length, 'Pending approvals')}
      ${stat(drivers.filter(d => d.approval === 'APPROVED').length, 'Approved drivers')}

      ${stat(drivers.filter(d => d.online).length, 'Online drivers')}
      ${stat(bookings.length, 'Total bookings')}
      ${stat(bookings.filter(b => !isTerminal(b.status)).length, 'Active rides')}
      ${stat(completed.length, 'Completed')}

      ${stat(bookings.filter(b => b.status === 'CANCELLED').length, 'Cancelled')}
      ${stat(inr(sum(completed, 'finalFare')), 'Gross fares')}
      ${stat(inr(sum(completed, 'commission')), 'Platform commission')}
      ${stat(inr(sum(completed, 'payout')), 'Driver payouts')}
    </div>

    <p class="note">
      Counts use the most recent 500 bookings.
      Fares are estimates recorded at trip completion.
    </p>
  `;
}

/* ---------------- CUSTOMERS ---------------- */

function customers(view) {
  const q = filt.q.toLowerCase();

  const rows = users.filter(u =>
    u.role === 'customer' &&
    (!q ||
      `${u.name || ''} ${u.email || ''} ${u.phone || ''}`
        .toLowerCase()
        .includes(q))
  );

  view.innerHTML = `
    <div class="card">
      <input
        id="fq"
        placeholder="Search name, email, phone"
        value="${esc(filt.q)}"
      >

      <div class="tw">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Contact</th>
              <th>Bookings</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>

          <tbody>
            ${
              rows.map(u => `
                <tr>
                  <td>${esc(u.name || '')}</td>
                  <td>
                    ${esc(u.email || '')}<br>
                    ${esc(u.phone || '')}
                  </td>
                  <td>
                    ${bookings.filter(b => b.customerId === u.id).length}
                  </td>
                  <td>${badge(u.status)}</td>
                  <td>
                    ${act('hist|' + u.id, 'History')}
                    ${
                      u.status === 'active'
                        ? act('sus|' + u.id, 'Suspend', 'bad')
                        : act('react|' + u.id, 'Reactivate', 'ok')
                    }
                  </td>
                </tr>
              `).join('') ||
              '<tr><td colspan="5" class="empty">No customers</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  $('#fq').oninput = e => {
    filt.q = e.target.value;
    preserveSearch(customers, view);
  };

  const setStatus = (id, status) => safe(async () => {
    await updateDoc(doc(db, 'users', id), { status });

    await audit('customer_' + status, id);
  }, 'Customer status updated');

  bind(view, {
    sus: id => {
      if (confirm('Suspend this customer?')) {
        setStatus(id, 'suspended');
      }
    },

    react: id => setStatus(id, 'active'),

    hist: id => {
      const rows = bookings.filter(b => b.customerId === id);

      dlg(`
        <h3>Booking history</h3>

        ${
          rows.length
            ? `
              <table>
                ${rows.map(b => `
                  <tr>
                    <td>${fmtTime(b.createdAt)}</td>
                    <td>${esc(SERVICES[b.service] || b.service || '')}</td>
                    <td>${inr(b.finalFare ?? b.fare)}</td>
                    <td>${badge(b.status)}</td>
                  </tr>
                `).join('')}
              </table>
            `
            : '<p class="muted">No booking history.</p>'
        }
      `);
    }
  });
}

/* ---------------- DRIVERS ---------------- */

function driversView(view) {
  const performance = id => {
    const rows = done().filter(b => b.driverId === id);

    return `${rows.length} trips · ${inr(sum(rows, 'finalFare'))}`;
  };

  view.innerHTML = `
    <div class="card tw">
      <table>
        <thead>
          <tr>
            <th>Driver</th>
            <th>Documents submitted</th>
            <th>Vehicle</th>
            <th>Status</th>
            <th>Performance</th>
            <th></th>
          </tr>
        </thead>

        <tbody>
          ${
            drivers.map(d => `
              <tr>
                <td>
                  <b>${esc(d.name || '')}</b><br>
                  ${esc(d.email || '')}<br>
                  ${esc(d.phone || '')}
                </td>

                <td>
                  Licence ${esc(d.licenseNo || '')}<br>
                  Exp ${esc(d.licenseExpiry || '')}<br>
                  RC ${esc(d.rcNo || '')}<br>
                  Ins. ${esc(d.insuranceNo || '')}
                </td>

                <td>
                  ${esc(d.vehicleModel || '')}<br>
                  ${esc(d.vehicleNo || '')} · ${esc(d.vehicleType || '')}
                </td>

                <td>
                  ${badge(d.approval)}
                  ${d.online ? '<br><span class="badge ok">online</span>' : ''}
                </td>

                <td>${performance(d.id)}</td>

                <td>
                  ${
                    d.approval === 'PENDING'
                      ? act('ok|' + d.id, 'Approve', 'ok') +
                        ' ' +
                        act('no|' + d.id, 'Reject', 'bad')
                      : ''
                  }

                  ${
                    d.approval === 'APPROVED'
                      ? act('sus|' + d.id, 'Suspend', 'bad')
                      : ''
                  }

                  ${
                    ['SUSPENDED', 'REJECTED'].includes(d.approval)
                      ? act('ok|' + d.id, 'Approve / reactivate', 'ok')
                      : ''
                  }
                </td>
              </tr>
            `).join('') ||
            '<tr><td colspan="6" class="empty">No drivers yet</td></tr>'
          }
        </tbody>
      </table>
    </div>

    <p class="note">
      Review the submitted licence, RC and insurance details
      against the original documents before approving.
      Document image upload is not enabled in this version.
    </p>
  `;

  const setApproval = (id, approval, note = '') =>
    safe(async () => {
      await updateDoc(doc(db, 'drivers', id), {
        approval,
        reviewedAt: serverTimestamp(),
        reviewNote: note,
        ...(approval !== 'APPROVED' ? { online: false } : {})
      });

      await audit(
        'driver_' + approval.toLowerCase(),
        id,
        note
      );
    }, 'Driver ' + approval.toLowerCase());

  bind(view, {
    ok: id => {
      if (confirm('Approve this driver?')) {
        setApproval(id, 'APPROVED');
      }
    },

    no: id => {
      const reason = prompt('Reason for rejection:');

      if (reason === null) return;

      setApproval(id, 'REJECTED', reason.trim());
    },

    sus: id => {
      if (confirm('Suspend this driver?')) {
        setApproval(id, 'SUSPENDED');
      }
    }
  });
}

/* ---------------- BOOKINGS ---------------- */

function bookingsView(view) {
  const q = filt.q.toLowerCase();

  const rows = bookings.filter(b =>
    (!filt.st || b.status === filt.st) &&
    (!q ||
      `${b.customerName || ''} ${b.pickup?.address || ''} ${
        b.drop?.address || ''
      } ${b.driverInfo?.name || ''} ${b.id}`
        .toLowerCase()
        .includes(q))
  );

  view.innerHTML = `
    <div class="card">
      <div class="row wrapf">
        <input
          id="fq"
          placeholder="Search customer, address, driver, id"
          value="${esc(filt.q)}"
        >

        <select id="fs" style="max-width:220px">
          <option value="">All statuses</option>

          ${
            Object.keys(STATUS).map(status => `
              <option
                value="${status}"
                ${filt.st === status ? 'selected' : ''}
              >
                ${STATUS[status]}
              </option>
            `).join('')
          }
        </select>
      </div>

      <div class="tw">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Customer</th>
              <th>Route</th>
              <th>Service</th>
              <th>Fare</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>

          <tbody>
            ${
              rows.map(b => `
                <tr>
                  <td>${fmtTime(b.createdAt)}</td>
                  <td>${esc(b.customerName || '')}</td>
                  <td>
                    ${esc(short(b.pickup?.address))}
                    ${b.drop ? ' → ' + esc(short(b.drop.address)) : ''}
                  </td>
                  <td>
                    ${esc(SERVICES[b.service] || b.service || '')}<br>
                    <small>${esc(b.vehicle || '')}</small>
                  </td>
                  <td>${inr(b.finalFare ?? b.fare)}</td>
                  <td>${badge(b.status)}</td>
                  <td>${act('view|' + b.id, 'Details')}</td>
                </tr>
              `).join('') ||
              '<tr><td colspan="7" class="empty">No bookings</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  $('#fq').oninput = e => {
    filt.q = e.target.value;
    preserveSearch(bookingsView, view);
  };

  $('#fs').onchange = e => {
    filt.st = e.target.value;
    bookingsView(view);
  };

  bind(view, {
    view: id => {
      const booking = bookings.find(b => b.id === id);
      if (booking) detail(booking);
    }
  });
}

/* ---------------- DRIVER ELIGIBILITY ---------------- */

const eligible = booking =>
  drivers
    .filter(d =>
      d.approval === 'APPROVED' &&
      d.online === true &&
      !d.activeBookingId &&
      d.vehicleType === booking.vehicle &&
      d.lat != null &&
      d.lng != null
    )
    .map(d => ({
      d,
      km: haversineKm(
        { lat: Number(d.lat), lng: Number(d.lng) },
        booking.pickup
      )
    }))
    .filter(x => Number.isFinite(x.km))
    .sort((a, b) => a.km - b.km);

/* ---------------- BOOKING DETAIL ---------------- */

function detail(booking) {
  const candidates = eligible(booking)
    .filter(x => x.km <= settings.dispatchRadiusKm);

  dlg(`
    <h3>
      Booking ${esc(booking.id.slice(0, 8))}
      ${badge(booking.status)}
    </h3>

    <p>
      ${esc(booking.customerName || '')} ·
      ${esc(SERVICES[booking.service] || booking.service || '')} ·
      ${esc(booking.vehicle || '')}
    </p>

    <p>
      📍 ${esc(booking.pickup?.address || '')}<br>
      🏁 ${esc(booking.drop?.address || 'Rental — no fixed destination')}
    </p>

    <p>
      Fare estimate: ${inr(booking.fare)}
      ${
        booking.finalFare != null
          ? ` · Final ${inr(booking.finalFare)}
             · Commission ${inr(booking.commission)}
             · Payout ${inr(booking.payout)}
             · Driver profit ${inr(booking.profit)}`
          : ''
      }
    </p>

    <p>
      Driver:
      ${esc(
        booking.driverInfo
          ? `${booking.driverInfo.name} (${booking.driverInfo.vehicleNo})`
          : 'None'
      )}
    </p>

    <p class="muted">
      Created ${fmtTime(booking.createdAt)} ·
      Assigned ${fmtTime(booking.assignedAt)} ·
      Arrived ${fmtTime(booking.arrivedAt)} ·
      Started ${fmtTime(booking.startedAt)} ·
      Completed ${fmtTime(booking.completedAt)}
    </p>

    ${
      ['SEARCHING_DRIVER', 'NO_DRIVER_AVAILABLE'].includes(booking.status)
        ? `
          <label>Manual assignment</label>

          <select id="asg">
            <option value="">Choose driver…</option>

            ${
              candidates.map(x => `
                <option value="${x.d.id}">
                  ${esc(x.d.name || 'Driver')} — ${x.km.toFixed(1)} km
                </option>
              `).join('')
            }
          </select>

          <p>
            <button type="button" class="btn gold sm" id="asgGo">
              Assign driver
            </button>
          </p>
        `
        : ''
    }

    ${
      !isTerminal(booking.status)
        ? `
          <p>
            <button type="button" class="btn bad sm" id="canGo">
              Cancel booking
            </button>
          </p>
        `
        : ''
    }
  `);

  $('#asgGo')?.addEventListener('click', async () => {
    const driverId = $('#asg').value;

    if (!driverId) {
      return toast('Choose a driver first', 'error');
    }

    await safe(async () => {
      await assignDriver(booking.id, driverId);

      await audit('manual_assign', booking.id, driverId);

      $('#dlg').close();
    }, 'Driver assigned');
  });

  $('#canGo')?.addEventListener('click', async () => {
    if (!confirm('Cancel this booking?')) return;

    await safe(async () => {
      await closeBooking(
        booking.id,
        'CANCELLED',
        'Cancelled by admin'
      );

      await audit('cancel_booking', booking.id);

      $('#dlg').close();
    }, 'Booking cancelled');
  });
}

/* ---------------- TRANSACTIONAL ASSIGNMENT ---------------- */

async function assignDriver(bookingId, driverId) {
  const bookingRef = doc(db, 'bookings', bookingId);
  const driverRef = doc(db, 'drivers', driverId);

  await runTransaction(db, async tx => {
    const bookingSnap = await tx.get(bookingRef);
    const driverSnap = await tx.get(driverRef);

    if (!bookingSnap.exists()) {
      throw new Error('Booking no longer exists');
    }

    if (!driverSnap.exists()) {
      throw new Error('Driver no longer exists');
    }

    const booking = bookingSnap.data();
    const driver = driverSnap.data();

    if (!['SEARCHING_DRIVER', 'NO_DRIVER_AVAILABLE'].includes(booking.status)) {
      throw new Error('This booking is no longer available for assignment');
    }

    if (booking.status === 'SEARCHING_DRIVER' &&
        booking.expiresAt &&
        ms(booking.expiresAt) <= Date.now()) {
      throw new Error('The driver search has expired');
    }

    if (driver.approval !== 'APPROVED') {
      throw new Error('This driver is not approved');
    }

    if (driver.online !== true) {
      throw new Error('This driver is currently offline');
    }

    if (driver.activeBookingId) {
      throw new Error('This driver already has an active booking');
    }

    if (driver.vehicleType !== booking.vehicle) {
      throw new Error('Driver vehicle does not match this booking');
    }

    if (driver.lat == null || driver.lng == null) {
      throw new Error('Driver location is unavailable');
    }

    const distance = haversineKm(
      { lat: Number(driver.lat), lng: Number(driver.lng) },
      booking.pickup
    );

    if (!Number.isFinite(distance) ||
        distance > settings.dispatchRadiusKm) {
      throw new Error('Driver is outside the dispatch radius');
    }

    tx.update(bookingRef, {
      status: 'DRIVER_ASSIGNED',
      driverId,
      assignedAt: serverTimestamp(),
      driverInfo: {
        name: driver.name || '',
        phone: driver.phone || '',
        vehicleModel: driver.vehicleModel || '',
        vehicleNo: driver.vehicleNo || '',
        vehicleType: driver.vehicleType || ''
      }
    });

    tx.update(driverRef, {
      activeBookingId: bookingId
    });
  });
}

/* ---------------- BOOKING CLEANUP ---------------- */

async function closeBooking(bookingId, newStatus, reason) {
  if (!['CANCELLED', 'NO_DRIVER_AVAILABLE'].includes(newStatus)) {
    throw new Error('Invalid closing status');
  }

  const bookingRef = doc(db, 'bookings', bookingId);

  await runTransaction(db, async tx => {
    const bookingSnap = await tx.get(bookingRef);

    if (!bookingSnap.exists()) {
      throw new Error('Booking not found');
    }

    const booking = bookingSnap.data();

    if (isTerminal(booking.status)) {
      throw new Error('This booking is already closed');
    }

    if (
      newStatus === 'NO_DRIVER_AVAILABLE' &&
      booking.status !== 'SEARCHING_DRIVER'
    ) {
      throw new Error('Only a searching booking can be marked unavailable');
    }

    const customerRef = booking.customerId
      ? doc(db, 'users', booking.customerId)
      : null;

    const driverRef = booking.driverId
      ? doc(db, 'drivers', booking.driverId)
      : null;

    // Read all related documents before writing.
    const customerSnap = customerRef
      ? await tx.get(customerRef)
      : null;

    const driverSnap = driverRef
      ? await tx.get(driverRef)
      : null;

    tx.update(bookingRef, {
      status: newStatus,
      ...(newStatus === 'CANCELLED'
        ? {
            cancelledAt: serverTimestamp(),
            cancelReason: reason
          }
        : {
            noDriverAt: serverTimestamp()
          })
    });

    if (
      customerSnap?.exists() &&
      customerSnap.data().activeBookingId === bookingId
    ) {
      tx.update(customerRef, {
        activeBookingId: null
      });
    }

    if (
      driverSnap?.exists() &&
      driverSnap.data().activeBookingId === bookingId
    ) {
      tx.update(driverRef, {
        activeBookingId: null
      });
    }
  });
}

/* ---------------- DISPATCH ---------------- */

function dispatch(view) {
  const searching = bookings.filter(
    b => b.status === 'SEARCHING_DRIVER'
  );

  const history = bookings
    .filter(b => b.assignedAt)
    .slice(0, 30);

  view.innerHTML = `
    <div class="card">
      <h3>Active driver searches (${searching.length})</h3>

      ${
        searching.map(booking => {
          const candidates = eligible(booking)
            .filter(x => x.km <= settings.dispatchRadiusKm);

          const remaining = Math.round(
            (ms(booking.expiresAt) - Date.now()) / 60000
          );

          return `
            <div class="card" style="margin:8px 0">
              <b>
                ${esc(SERVICES[booking.service] || booking.service || '')}
                · ${esc(booking.vehicle || '')}
              </b>

              ${
                remaining > 0
                  ? `<span class="badge">${remaining} min left</span>`
                  : '<span class="badge bad">Expired</span>'
              }

              <br>
              📍 ${esc(short(booking.pickup?.address))}

              <br>

              <span class="muted">
                Eligible within ${settings.dispatchRadiusKm} km:
                ${
                  candidates.length
                    ? candidates.map(x =>
                        `${esc(x.d.name || 'Driver')} (${x.km.toFixed(1)} km)`
                      ).join(', ')
                    : 'None'
                }
              </span>

              <br>

              ${act('view|' + booking.id, 'Assign / manage')}

              ${
                remaining <= 0
                  ? act('exp|' + booking.id, 'Mark no driver', 'bad')
                  : ''
              }
            </div>
          `;
        }).join('') ||
        '<div class="empty">No active searches.</div>'
      }
    </div>

    <div class="card" style="margin-top:12px">
      <h3>Online drivers</h3>

      <p>
        ${
          drivers.filter(d => d.online).map(d =>
            `${esc(d.name || 'Driver')} (${esc(d.vehicleType || '')}${
              d.activeBookingId ? ', on ride' : ', free'
            })`
          ).join(' · ') ||
          '<span class="muted">None online</span>'
        }
      </p>
    </div>

    <div class="card tw" style="margin-top:12px">
      <h3>Assignment history</h3>

      <table>
        ${
          history.map(b => `
            <tr>
              <td>${fmtTime(b.assignedAt)}</td>
              <td>${esc(b.driverInfo?.name || '')}</td>
              <td>${esc(short(b.pickup?.address))}</td>
              <td>${badge(b.status)}</td>
            </tr>
          `).join('') ||
          '<tr><td class="empty">None yet</td></tr>'
        }
      </table>
    </div>
  `;

  bind(view, {
    view: id => {
      const booking = bookings.find(b => b.id === id);
      if (booking) detail(booking);
    },

    exp: id => {
      if (!confirm('Mark this booking as no driver available?')) return;

      safe(async () => {
        await closeBooking(
          id,
          'NO_DRIVER_AVAILABLE',
          'No driver available'
        );

        await audit('mark_no_driver', id);
      }, 'Booking marked unavailable');
    }
  });
}

/* ---------------- FARE SETTINGS ---------------- */

const FIELDS = [
  ['commissionPct', 'Platform commission %'],
  ['fuelPrice', 'Fuel price ₹/litre'],
  ['waitFreeMin', 'Free waiting (min)'],
  ['waitPerMin', 'Waiting ₹/min'],
  ['airportSurcharge', 'Airport surcharge ₹'],
  ['outstationPerKmMult', 'Outstation per-km multiplier'],
  ['outstationMinKm', 'Outstation minimum billed km'],
  ['dispatchRadiusKm', 'Dispatch radius km'],
  ['offerTimeoutMin', 'Search timeout (min)'],
  ['expenseKmPerHour', 'Assumed km per rental hour']
];

const VF = [
  ['base', 'Base ₹'],
  ['perKm', '₹/km'],
  ['minFare', 'Min fare ₹'],
  ['mileage', 'Mileage km/l'],
  ['maintPerKm', 'Maintenance ₹/km'],
  ['hourly', 'Hourly ₹'],
  ['fullDay', 'Full-day ₹']
];

function fares(view) {
  if (view.querySelector('#fsForm')) return;

  view.innerHTML = `
    <form id="fsForm" class="card">
      <h3>
        Fare settings
        <span class="muted" style="font-size:.8rem">
          (sample assumptions — not official tariffs)
        </span>
      </h3>

      <div class="grid g4 keep2">
        ${
          FIELDS.map(([key, label]) => `
            <div>
              <label>${label}</label>
              <input
                type="number"
                step="any"
                min="0"
                name="${key}"
                value="${settings[key] ?? 0}"
                required
              >
            </div>
          `).join('')
        }
      </div>

      ${
        VEHICLES.map(vehicle => `
          <h3 style="margin-top:18px">
            ${esc(settings.vehicles[vehicle].label)}
          </h3>

          <div class="grid g4 keep2">
            ${
              VF.map(([key, label]) => `
                <div>
                  <label>${label}</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    name="v.${vehicle}.${key}"
                    value="${settings.vehicles[vehicle][key] ?? 0}"
                    required
                  >
                </div>
              `).join('')
            }
          </div>
        `).join('')
      }

      <p>
        <button class="btn gold" type="submit">
          Save settings
        </button>
      </p>
    </form>
  `;

  $('#fsForm').onsubmit = e => {
    e.preventDefault();

    const form = new FormData(e.target);
    const output = { vehicles: {} };

    for (const [key, value] of form.entries()) {
      const number = Number(value);

      if (!Number.isFinite(number) || number < 0) {
        return toast('Invalid value for ' + key, 'error');
      }

      if (key.startsWith('v.')) {
        const [, vehicle, property] = key.split('.');
        (output.vehicles[vehicle] ||= {})[property] = number;
      } else {
        output[key] = number;
      }
    }

    if (output.commissionPct > 100) {
      return toast('Commission cannot exceed 100%', 'error');
    }

    if (output.dispatchRadiusKm <= 0 || output.offerTimeoutMin <= 0) {
      return toast('Dispatch radius and search timeout must be greater than zero', 'error');
    }

    safe(async () => {
      await setDoc(
        doc(db, 'settings', 'fare'),
        output,
        { merge: true }
      );

      settings = await loadSettings();

      await audit(
        'update_fare_settings',
        'settings/fare',
        JSON.stringify(output).slice(0, 400)
      );

      render();
    }, 'Settings saved');
  };
}

/* ---------------- ANALYTICS ---------------- */

function analytics(view) {
  const completed = done();

  const days = [...Array(14)].map((_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - 13 + index);
    return date;
  });

  const perDay = days.map(date => {
    const end = date.getTime() + 864e5;

    const rows = bookings.filter(b =>
      ms(b.createdAt) >= date.getTime() &&
      ms(b.createdAt) < end
    );

    return {
      label: date.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short'
      }),
      count: rows.length,
      revenue: sum(
        rows.filter(b => b.status === 'TRIP_COMPLETED'),
        'finalFare'
      )
    };
  });

  const maximum = Math.max(1, ...perDay.map(x => x.count));
  const total = bookings.length || 1;

  const months = {};

  completed.forEach(b => {
    const timestamp = ms(b.completedAt);

    if (!timestamp) return;

    const key = new Date(timestamp).toLocaleDateString('en-IN', {
      month: 'short',
      year: 'numeric'
    });

    (months[key] ||= []).push(b);
  });

  view.innerHTML = `
    <div class="grid g2">
      <div class="card">
        <h3>Bookings — last 14 days</h3>

        ${
          perDay.map(x => `
            <div class="row" style="margin:4px 0">
              <small style="width:52px">${x.label}</small>

              <div
                class="bar"
                style="width:${x.count / maximum * 100}%"
              ></div>

              <small>${x.count} · ${inr(x.revenue)}</small>
            </div>
          `).join('')
        }
      </div>

      <div class="card">
        <h3>Rates</h3>

        <div class="grid g2">
          ${stat(
            Math.round(completed.length / total * 100) + '%',
            'Completion rate'
          )}

          ${stat(
            Math.round(
              bookings.filter(b => b.status === 'CANCELLED').length /
              total * 100
            ) + '%',
            'Cancellation rate'
          )}
        </div>

        <h3 style="margin-top:14px">By vehicle (completed)</h3>

        ${
          VEHICLES.map(vehicle => {
            const rows = completed.filter(b => b.vehicle === vehicle);

            return `
              <p>
                ${esc(settings.vehicles[vehicle].label)}:
                <b>${rows.length}</b> trips ·
                ${inr(sum(rows, 'finalFare'))}
              </p>
            `;
          }).join('')
        }
      </div>
    </div>

    <div class="card tw" style="margin-top:12px">
      <h3>Monthly</h3>

      <table>
        <thead>
          <tr>
            <th>Month</th>
            <th>Trips</th>
            <th>Revenue</th>
            <th>Commission</th>
            <th>Driver payout</th>
          </tr>
        </thead>

        <tbody>
          ${
            Object.entries(months).map(([month, rows]) => `
              <tr>
                <td>${month}</td>
                <td>${rows.length}</td>
                <td>${inr(sum(rows, 'finalFare'))}</td>
                <td>${inr(sum(rows, 'commission'))}</td>
                <td>${inr(sum(rows, 'payout'))}</td>
              </tr>
            `).join('') ||
            '<tr><td colspan="5" class="empty">No completed trips yet</td></tr>'
          }
        </tbody>
      </table>
    </div>
  `;
}

/* ---------------- SUPPORT ---------------- */

function support(view) {
  view.innerHTML = `
    <div class="card">
      ${
        tickets.map(ticket => `
          <div class="card" style="margin:8px 0">
            <b>${esc(ticket.subject || '')}</b>
            ${badge(ticket.status)}

            <br>

            <span class="muted">
              ${esc(ticket.name || '')} ·
              ${esc(ticket.email || '')} ·
              ${esc(ticket.phone || '')} ·
              ${fmtTime(ticket.createdAt)}
            </span>

            <p>${esc(ticket.message || '')}</p>

            ${
              ticket.reply
                ? `<p><i>Reply: ${esc(ticket.reply)}</i></p>`
                : ''
            }

            ${
              ticket.status === 'OPEN'
                ? act('rep|' + ticket.id, 'Reply & close')
                : ''
            }
          </div>
        `).join('') ||
        '<div class="empty">No support requests.</div>'
      }
    </div>
  `;

  bind(view, {
    rep: id => {
      const reply = prompt('Reply to customer:');

      if (!reply || !reply.trim()) return;

      safe(async () => {
        await updateDoc(doc(db, 'support', id), {
          reply: reply.trim(),
          status: 'CLOSED',
          repliedAt: serverTimestamp()
        });

        await audit('support_reply', id);
      }, 'Reply sent');
    }
  });
}

/* ---------------- DIALOG ---------------- */

function dlg(html) {
  $('#dlgBody').innerHTML = html;
  $('#dlg').showModal();
}
