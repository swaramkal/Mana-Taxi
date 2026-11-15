
import {
  $,
  esc,
  inr,
  ms,
  fmtTime,
  toast,
  badge,
  TERMINAL,
  initTheme,
  initNav,
  showConfigBanner,
  requireRole,
  loadSettings,
  db,
  collection,
  doc,
  query,
  where,
  onSnapshot,
  updateDoc,
  runTransaction,
  writeBatch,
  serverTimestamp
} from "./common.js";

import {
  SERVICES,
  haversineKm,
  waitingCharge,
  calcEarnings
} from "./fare.js";

// --------------------------------------------------
// INITIALIZATION
// --------------------------------------------------

initTheme();
initNav();
showConfigBanner();

let me = null;
let prof = null;
let drv = null;
let settings = null;

let active = null;
let offers = [];
let trips = [];

let watchId = null;
let lastPush = 0;

let unsubOffers = null;
let unsubActive = null;

let activeId = null;
let contact = null;

let offerTimer = null;

let rejected = new Set();

try {
  rejected = new Set(
    JSON.parse(sessionStorage.getItem("mt_rej") || "[]")
  );
} catch {
  sessionStorage.removeItem("mt_rej");
}

const short = address =>
  (address || "")
    .split(",")
    .slice(0, 3)
    .join(",");

const terminal = status =>
  TERMINAL.includes(status);

const validPosition = point =>
  point &&
  Number.isFinite(point.lat) &&
  Number.isFinite(point.lng);

// --------------------------------------------------
// DRIVER DASHBOARD
// --------------------------------------------------

requireRole("driver", async (user, profile) => {
  me = user;
  prof = profile;

  try {
    settings = await loadSettings();

    if (!settings?.vehicles) {
      throw new Error("Vehicle settings are unavailable.");
    }

    $("#hello").textContent =
      `Hi, ${(profile.name || "driver").split(" ")[0]} 🚕`;

    // Dashboard navigation.
    document.querySelectorAll(".tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".pane").forEach(pane => {
          pane.classList.toggle(
            "on",
            pane.id === tab.dataset.p
          );
        });

        document.querySelectorAll(".tab").forEach(item => {
          item.classList.toggle("on", item === tab);
        });
      });
    });

    // Driver profile listener.
    onSnapshot(
      doc(db, "drivers", me.uid),

      snapshot => {
        if (!snapshot.exists()) {
          toast("Driver profile not found. Contact support.", "error");
          return;
        }

        drv = {
          id: snapshot.id,
          ...snapshot.data()
        };

        renderStatus();
        renderProfile();
        syncOffers();
        syncActive();
        syncWatch();
      },

      error => {
        console.error("Driver profile listener:", error);
        toast(error.message, "error");
      }
    );

    // Completed trip history.
    onSnapshot(
      query(
        collection(db, "bookings"),
        where("driverId", "==", me.uid)
      ),

      snapshot => {
        trips = snapshot.docs
          .map(item => ({
            id: item.id,
            ...item.data()
          }))
          .filter(item => item.status === "TRIP_COMPLETED")
          .sort(
            (a, b) =>
              ms(b.completedAt) - ms(a.completedAt)
          );

        renderEarnings();
        renderHistory();
      },

      error => {
        console.error("Trip history listener:", error);
        toast("Could not load trip history.", "error");
      }
    );

    // Earnings calculator.
    ["cF", "cK", "cO"].forEach(id => {
      $("#" + id).addEventListener("input", calc);
    });

    calc();

    offerTimer = setInterval(renderOffers, 1000);

  } catch (error) {
    console.error("Driver dashboard initialization:", error);

    toast(
      "Could not initialize driver dashboard: " + error.message,
      "error"
    );
  }
});

// --------------------------------------------------
// DRIVER STATUS
// --------------------------------------------------

function renderStatus() {
  if (!drv) return;

  const approved = drv.approval === "APPROVED";

  $("#statusCard").innerHTML = `
    <div
      class="row wrapf"
      style="justify-content:space-between">

      <div>
        <b>Approval:</b>
        ${badge(drv.approval)}

        ${
          drv.approval === "PENDING"
            ? `
              <p class="muted">
                Your documents are being reviewed.
                You can go online once approved.
              </p>
            `
            : ""
        }

        ${
          drv.approval === "REJECTED"
            ? `
              <p class="gold">
                Application rejected.
                ${esc(drv.reviewNote || "")}
                Contact support.
              </p>
            `
            : ""
        }

        ${
          drv.approval === "SUSPENDED"
            ? `
              <p class="gold">
                Your account is suspended. Contact support.
              </p>
            `
            : ""
        }

      </div>

      <div class="row">
        <span>
          ${
            drv.online
              ? '<b class="gold">Online</b>'
              : "Offline"
          }
        </span>

        <button
          class="switch ${drv.online ? "on" : ""}"
          id="onoff"
          aria-label="Go online or offline"
          ${approved ? "" : "disabled"}>
        </button>
      </div>

    </div>

    <p class="note">
      ${
        drv.online
          ? "Sharing your location while online."
          : "Location is shared only while you are online."
      }

      ${
        validPosition({
          lat: drv.lat,
          lng: drv.lng
        })
          ? ""
          : " Location not captured yet."
      }
    </p>
  `;

  $("#onoff").addEventListener("click", toggleOnline);
}

// --------------------------------------------------
// CURRENT LOCATION
// --------------------------------------------------

function getPos() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location is not supported."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      resolve,
      reject,
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 5000
      }
    );
  });
}

// --------------------------------------------------
// ONLINE / OFFLINE
// --------------------------------------------------

async function toggleOnline() {
  if (!drv) return;

  try {
    if (drv.approval !== "APPROVED") {
      toast("Your driver account is not approved yet.", "error");
      return;
    }

    if (drv.online) {
      if (drv.activeBookingId) {
        toast("Finish your active ride first.", "error");
        return;
      }

      await updateDoc(
        doc(db, "drivers", me.uid),
        {
          online: false,
          updatedAt: serverTimestamp()
        }
      );

      toast("You are now offline.");
      return;
    }

    const position = await getPos();

    await updateDoc(
      doc(db, "drivers", me.uid),
      {
        online: true,
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        updatedAt: serverTimestamp()
      }
    );

    toast("You are online.", "success");

  } catch (error) {
    console.error("Online status error:", error);

    toast(
      error.code === 1
        ? "Location permission is required to go online."
        : error.message,
      "error"
    );
  }
}

// --------------------------------------------------
// DRIVER LOCATION WATCH
// --------------------------------------------------

function syncWatch() {
  if (!drv) return;

  if (
    drv.online &&
    watchId === null &&
    navigator.geolocation
  ) {
    watchId = navigator.geolocation.watchPosition(
      position => {
        if (Date.now() - lastPush < 8000) return;

        lastPush = Date.now();

        const lat = position.coords.latitude;
        const lng = position.coords.longitude;

        updateDoc(
          doc(db, "drivers", me.uid),
          {
            lat,
            lng,
            updatedAt: serverTimestamp()
          }
        ).catch(error => {
          console.error("Driver location update:", error);
        });

        if (
          active &&
          [
            "DRIVER_ASSIGNED",
            "DRIVER_ARRIVED",
            "TRIP_STARTED"
          ].includes(active.status)
        ) {
          updateDoc(
            doc(db, "bookings", active.id),
            {
              driverLoc: {
                lat,
                lng,
                t: Date.now()
              }
            }
          ).catch(error => {
            console.error("Booking location update:", error);
          });
        }
      },

      error => {
        console.error("Geolocation watch error:", error);
        toast("Location updates failed.", "error");
      },

      {
        enableHighAccuracy: true,
        maximumAge: 5000
      }
    );

  } else if (!drv.online && watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

// --------------------------------------------------
// INCOMING RIDE OFFERS
// --------------------------------------------------

function syncOffers() {
  if (!drv) return;

  const shouldListen =
    drv.online &&
    drv.approval === "APPROVED" &&
    !drv.activeBookingId;

  if (shouldListen && !unsubOffers) {
    unsubOffers = onSnapshot(
      query(
        collection(db, "bookings"),
        where("status", "==", "SEARCHING_DRIVER")
      ),

      snapshot => {
        offers = snapshot.docs.map(item => ({
          id: item.id,
          ...item.data()
        }));

        renderOffers();
      },

      error => {
        console.error("Offer listener error:", error);
        toast("Offers: " + error.message, "error");
      }
    );
  }

  if (!shouldListen && unsubOffers) {
    unsubOffers();
    unsubOffers = null;

    offers = [];

    renderOffers();
  }
}

// --------------------------------------------------
// RENDER INCOMING OFFERS
// --------------------------------------------------

function renderOffers() {
  const element = $("#offers");

  if (!element || !drv || !settings) return;

  if (drv.approval !== "APPROVED") {
    element.innerHTML = `
      <div class="empty card" style="grid-column:1/-1">
        Your driver application must be approved before receiving rides.
      </div>
    `;
    return;
  }

  if (!drv.online) {
    element.innerHTML = `
      <div class="empty card" style="grid-column:1/-1">
        Go online to receive nearby ride requests.
      </div>
    `;
    return;
  }

  if (drv.activeBookingId) {
    element.innerHTML = `
      <div class="empty card" style="grid-column:1/-1">
        Complete your current ride to receive new requests.
      </div>
    `;
    return;
  }

  if (!validPosition({ lat: drv.lat, lng: drv.lng })) {
    element.innerHTML = `
      <div class="empty card" style="grid-column:1/-1">
        Waiting for your location...
      </div>
    `;
    return;
  }

  const driverPosition = {
    lat: drv.lat,
    lng: drv.lng
  };

  const radius = Number(settings.dispatchRadiusKm || 5);

  const list = offers
    .filter(booking =>
      booking.vehicle === drv.vehicleType &&
      !rejected.has(booking.id) &&
      ms(booking.expiresAt) > Date.now() &&
      validPosition(booking.pickup)
    )
    .map(booking => ({
      booking,
      distance: haversineKm(
        driverPosition,
        booking.pickup
      )
    }))
    .filter(item => item.distance <= radius)
    .sort((a, b) => a.distance - b.distance);

  if (!list.length) {
    element.innerHTML = `
      <div class="empty card" style="grid-column:1/-1">
        <span class="spin"></span>
        No requests within ${esc(radius)} km right now.
      </div>
    `;
    return;
  }

  element.innerHTML = list.map(({ booking, distance }) => `
    <div class="card fade">

      <div
        class="row"
        style="justify-content:space-between">

        <b>
          ${esc(SERVICES[booking.service] || booking.service)}
        </b>

        <b class="gold">
          ${inr(booking.fare)}
        </b>

      </div>

      <p>
        📍 ${esc(short(booking.pickup.address))}

        <br>

        🏁 ${
          esc(
            booking.drop
              ? short(booking.drop.address)
              : "Rental"
          )
        }
      </p>

      <p class="muted">
        ${distance.toFixed(1)} km from you

        ${
          booking.distanceKm
            ? ` · trip ${esc(booking.distanceKm)} km`
            : ""
        }

        · ${
          Math.max(
            0,
            Math.round(
              (ms(booking.expiresAt) - Date.now()) / 60000
            )
          )
        } min left
      </p>

      <div class="row">
        <button
          class="btn ok"
          data-a="${esc(booking.id)}">
          Accept
        </button>

        <button
          class="btn ghost"
          data-r="${esc(booking.id)}">
          Reject
        </button>
      </div>

    </div>
  `).join("");

  element.querySelectorAll("[data-a]").forEach(button => {
    button.addEventListener("click", () => {
      accept(button.dataset.a, button);
    });
  });

  element.querySelectorAll("[data-r]").forEach(button => {
    button.addEventListener("click", () => {
      rejected.add(button.dataset.r);

      sessionStorage.setItem(
        "mt_rej",
        JSON.stringify([...rejected])
      );

      renderOffers();
    });
  });
}

// --------------------------------------------------
// ACCEPT REQUEST TRANSACTION
// --------------------------------------------------

async function accept(id, button) {
  if (!drv || !id || button.disabled) return;

  button.disabled = true;

  try {
    await runTransaction(db, async transaction => {
      const bookingRef = doc(db, "bookings", id);
      const driverRef = doc(db, "drivers", me.uid);

      // Read booking and driver.
      const bookingSnapshot = await transaction.get(bookingRef);
      const driverSnapshot = await transaction.get(driverRef);

      if (!bookingSnapshot.exists()) {
        throw new Error("This ride no longer exists.");
      }

      if (!driverSnapshot.exists()) {
        throw new Error("Driver profile not found.");
      }

      const booking = bookingSnapshot.data();
      const driver = driverSnapshot.data();

      // Check current booking state.
      if (booking.status !== "SEARCHING_DRIVER") {
        throw new Error("TAKEN");
      }

      if (
        booking.expiresAt &&
        ms(booking.expiresAt) <= Date.now()
      ) {
        throw new Error("EXPIRED");
      }

      // Check driver eligibility.
      if (driver.approval !== "APPROVED") {
        throw new Error("NOT_APPROVED");
      }

      if (!driver.online) {
        throw new Error("OFFLINE");
      }

      if (driver.activeBookingId) {
        throw new Error("BUSY");
      }

      if (driver.vehicleType !== booking.vehicle) {
        throw new Error("VEHICLE_MISMATCH");
      }

      if (booking.driverId) {
        throw new Error("TAKEN");
      }

      // Check customer booking link.
      const customerRef = doc(
        db,
        "users",
        booking.customerId
      );

      const customerSnapshot =
        await transaction.get(customerRef);

      if (!customerSnapshot.exists()) {
        throw new Error("CUSTOMER_NOT_FOUND");
      }

      if (
        customerSnapshot.data().activeBookingId !== id
      ) {
        throw new Error("BOOKING_LINK_INVALID");
      }

      // Assign booking and driver lock atomically.
      transaction.update(bookingRef, {
        status: "DRIVER_ASSIGNED",
        driverId: me.uid,
        assignedAt: serverTimestamp(),

        driverInfo: {
          name: driver.name,
          phone: driver.phone,
          vehicleModel: driver.vehicleModel,
          vehicleNo: driver.vehicleNo,
          vehicleType: driver.vehicleType
        }
      });

      transaction.update(driverRef, {
        activeBookingId: id
      });
    });

    toast("Ride accepted!", "success");

  } catch (error) {
    console.error("Accept booking error:", error);

    const messages = {
      TAKEN: "Too late — another driver took this ride.",
      EXPIRED: "This ride request has expired.",
      BUSY: "You already have an active ride.",
      OFFLINE: "You are offline.",
      NOT_APPROVED: "Your account is not approved.",
      VEHICLE_MISMATCH: "This ride does not match your vehicle.",
      CUSTOMER_NOT_FOUND: "Customer account not found.",
      BOOKING_LINK_INVALID: "The customer booking is no longer active."
    };

    toast(
      messages[error.message] ||
      error.message ||
      "Could not accept this ride.",
      "error"
    );

    button.disabled = false;
  }
}

// --------------------------------------------------
// ACTIVE BOOKING LISTENER
// --------------------------------------------------

function syncActive() {
  if (!drv) return;

  const id = drv.activeBookingId || null;

  if (id === activeId) return;

  activeId = id;

  unsubActive?.();
  unsubActive = null;

  active = null;
  contact = null;

  if (!id) {
    renderActive();
    return;
  }

  unsubActive = onSnapshot(
    doc(db, "bookings", id),

    async snapshot => {
      active = snapshot.exists()
        ? {
            id,
            ...snapshot.data()
          }
        : null;

      contact = null;

      if (
        active &&
        !terminal(active.status)
      ) {
        try {
          const contactSnapshot = await import("./common.js")
            .then(module =>
              module.getDoc(
                doc(
                  db,
                  "bookings",
                  id,
                  "contact",
                  "info"
                )
              )
            );

          if (contactSnapshot.exists()) {
            contact = contactSnapshot.data();
          }
        } catch (error) {
          console.error("Contact lookup:", error);
        }
      }

      if (!active || terminal(active.status)) {
        if (active?.status === "CANCELLED") {
          toast("The customer cancelled this ride.", "error");
        }

        releaseDriverLock(id).catch(error => {
          console.error("Driver lock release:", error);
        });
      }

      renderActive();
    },

    error => {
      console.error("Active booking listener:", error);
      toast("Could not load active ride.", "error");
    }
  );
}

// --------------------------------------------------
// RELEASE DRIVER LOCK
// --------------------------------------------------

async function releaseDriverLock(bookingId) {
  await runTransaction(db, async transaction => {
    const driverRef = doc(db, "drivers", me.uid);

    const driverSnapshot =
      await transaction.get(driverRef);

    if (!driverSnapshot.exists()) return;

    const driver = driverSnapshot.data();

    if (driver.activeBookingId !== bookingId) {
      return;
    }

    transaction.update(driverRef, {
      activeBookingId: null
    });
  });
}

// --------------------------------------------------
// ACTIVE RIDE DISPLAY
// --------------------------------------------------

function renderActive() {
  const element = $("#activeBox");

  if (!element) return;

  if (!active || terminal(active.status)) {
    element.innerHTML = "";
    return;
  }

  const previousOther = $("#oth")?.value;

  const booking = active;

  const navigation = point =>
    `https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lng}&travelmode=driving`;

  const next = {
    DRIVER_ASSIGNED: [
      "DRIVER_ARRIVED",
      "I have arrived"
    ],

    DRIVER_ARRIVED: [
      "TRIP_STARTED",
      "Start trip"
    ],

    TRIP_STARTED: [
      "TRIP_COMPLETED",
      "Complete trip"
    ]
  }[booking.status];

  element.innerHTML = `
    <div
      class="card fade"
      style="border-color:var(--gold)">

      <div
        class="row wrapf"
        style="justify-content:space-between">

        <h3 style="margin:0">
          Active ride ·
          ${esc(SERVICES[booking.service] || booking.service)}
        </h3>

        ${badge(booking.status)}

      </div>

      <p>
        👤 ${esc(booking.customerName || "Customer")}

        ${
          contact?.phone
            ? ` · <a href="tel:${esc(contact.phone)}">${esc(contact.phone)}</a>`
            : ""
        }
      </p>

      <p>
        📍 <b>Pickup:</b>
        ${esc(booking.pickup?.address || "")}

        <br>

        🏁 <b>Drop:</b>
        ${
          esc(
            booking.drop?.address ||
            "Rental — as directed by customer"
          )
        }
      </p>

      <p>
        Fare estimate:
        <b class="gold">${inr(booking.fare)}</b>

        ${
          booking.distanceKm
            ? ` · ${esc(booking.distanceKm)} km`
            : ""
        }
      </p>

      <div class="row wrapf">

        ${
          validPosition(booking.pickup)
            ? `
              <a
                class="btn sm"
                target="_blank"
                rel="noopener"
                href="${navigation(booking.pickup)}">
                Navigate to pickup
              </a>
            `
            : ""
        }

        ${
          validPosition(booking.drop)
            ? `
              <a
                class="btn sm"
                target="_blank"
                rel="noopener"
                href="${navigation(booking.drop)}">
                Navigate to drop
              </a>
            `
            : ""
        }

      </div>

      ${
        booking.status === "TRIP_STARTED"
          ? `
            <label for="oth">
              Other trip expenses (₹, e.g. tolls/parking)
            </label>

            <input
              id="oth"
              type="number"
              min="0"
              max="100000"
              value="0">
          `
          : ""
      }

      <p style="margin-top:12px">
        ${
          next
            ? `
              <button
                class="btn gold block"
                id="adv">
                ${next[1]}
              </button>
            `
            : ""
        }
      </p>

      <p class="note">
        ${
          booking.status === "DRIVER_ARRIVED"
            ? `First ${esc(settings.waitFreeMin)} min waiting is free, then ${inr(settings.waitPerMin)}/min.`
            : ""
        }
      </p>

    </div>
  `;

  if (previousOther !== undefined && $("#oth")) {
    $("#oth").value = previousOther;
  }

  $("#adv")?.addEventListener("click", event => {
    advance(next[0], event.target);
  });
}

// --------------------------------------------------
// ADVANCE TRIP STATUS
// --------------------------------------------------

async function advance(nextStatus, button) {
  if (!active || !button || button.disabled) return;

  const bookingId = active.id;

  button.disabled = true;

  try {
    await runTransaction(db, async transaction => {
      const bookingRef = doc(
        db,
        "bookings",
        bookingId
      );

      const driverRef = doc(
        db,
        "drivers",
        me.uid
      );

      const bookingSnapshot =
        await transaction.get(bookingRef);

      const driverSnapshot =
        await transaction.get(driverRef);

      if (
        !bookingSnapshot.exists() ||
        !driverSnapshot.exists()
      ) {
        throw new Error("Booking or driver profile not found.");
      }

      const booking = bookingSnapshot.data();
      const driver = driverSnapshot.data();

      if (booking.driverId !== me.uid) {
        throw new Error("This ride is not assigned to you.");
      }

      if (driver.activeBookingId !== bookingId) {
        throw new Error("Your active ride link is invalid.");
      }

      const allowed = {
        DRIVER_ASSIGNED: "DRIVER_ARRIVED",
        DRIVER_ARRIVED: "TRIP_STARTED",
        TRIP_STARTED: "TRIP_COMPLETED"
      };

      if (allowed[booking.status] !== nextStatus) {
        throw new Error("This ride status has changed. Refresh and try again.");
      }

      const update = {
        status: nextStatus
      };

      if (nextStatus === "DRIVER_ARRIVED") {
        update.arrivedAt = serverTimestamp();

        transaction.update(bookingRef, update);
        return;
      }

      if (nextStatus === "TRIP_STARTED") {
        const waitingMinutes = Math.max(
          0,
          (Date.now() - ms(booking.arrivedAt)) / 60000
        );

        update.startedAt = serverTimestamp();
        update.waitMinutes = Math.round(waitingMinutes);

        update.waitingCharge = waitingCharge(
          settings,
          waitingMinutes
        );

        transaction.update(bookingRef, update);
        return;
      }

      // --------------------------------------------
      // COMPLETE TRIP
      // --------------------------------------------

      const other = Math.max(
        0,
        Number($("#oth")?.value) || 0
      );

      if (other > 100000) {
        throw new Error("Other expenses exceed the allowed limit.");
      }

      const finalFare =
        Number(booking.fare || 0) +
        Number(booking.waitingCharge || 0);

      const earnings = calcEarnings(
        settings,
        booking.vehicle,
        finalFare,
        booking.expenseKm ?? booking.distanceKm ?? 0,
        other
      );

      const customerRef = doc(
        db,
        "users",
        booking.customerId
      );

      const customerSnapshot =
        await transaction.get(customerRef);

      if (!customerSnapshot.exists()) {
        throw new Error("Customer account not found.");
      }

      if (
        customerSnapshot.data().activeBookingId !== bookingId
      ) {
        throw new Error("Customer booking link is invalid.");
      }

      transaction.update(bookingRef, {
        ...update,

        completedAt: serverTimestamp(),

        finalFare,

        commissionPct: settings.commissionPct,
        commission: earnings.commission,
        payout: earnings.payout,

        fuelExpense: earnings.fuel,
        maintExpense: earnings.maint,
        otherExpense: other,

        profit: earnings.profit
      });

      // Release driver and customer locks together.
      transaction.update(driverRef, {
        activeBookingId: null
      });

      transaction.update(customerRef, {
        activeBookingId: null
      });
    });

    toast("Trip completed successfully.", "success");

  } catch (error) {
    console.error("Trip status update:", error);

    toast(
      "Update failed: " + error.message,
      "error"
    );

    button.disabled = false;
  }
}

// --------------------------------------------------
// EARNINGS HELPERS
// --------------------------------------------------

const sum = (rows, key) =>
  rows.reduce(
    (total, row) =>
      total + (Number(row[key]) || 0),
    0
  );

// --------------------------------------------------
// EARNINGS DASHBOARD
// --------------------------------------------------

function renderEarnings() {
  const now = new Date();

  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime();

  const monthStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    1
  ).getTime();

  const card = (title, rows) => `
    <div class="card">

      <h3>${title}</h3>

      <div class="grid g2">

        <div class="stat">
          <b>${rows.length}</b>
          <span>Trips</span>
        </div>

        <div class="stat">
          <b>${inr(sum(rows, "finalFare"))}</b>
          <span>Customer fares</span>
        </div>

        <div class="stat">
          <b>${inr(sum(rows, "commission"))}</b>
          <span>Platform commission</span>
        </div>

        <div class="stat">
          <b>${inr(sum(rows, "payout"))}</b>
          <span>Driver payout</span>
        </div>

        <div class="stat">
          <b>
            ${inr(
              sum(rows, "fuelExpense") +
              sum(rows, "maintExpense") +
              sum(rows, "otherExpense")
            )}
          </b>

          <span>Fuel + maintenance + other</span>
        </div>

        <div class="stat">
          <b class="gold">
            ${inr(sum(rows, "profit"))}
          </b>

          <span>Estimated profit</span>
        </div>

      </div>
    </div>
  `;

  $("#earnBox").innerHTML = `
    <div class="grid g2">

      ${card(
        "Today",
        trips.filter(
          trip => ms(trip.completedAt) >= todayStart
        )
      )}

      ${card(
        "This month",
        trips.filter(
          trip => ms(trip.completedAt) >= monthStart
        )
      )}

    </div>

    <p class="note">
      Profit = payout − fuel − maintenance − other expenses,
      using the administrator's current sample assumptions.
      These figures are estimates.
    </p>
  `;
}

// --------------------------------------------------
// TRIP HISTORY
// --------------------------------------------------

function renderHistory() {
  $("#histBox").innerHTML = trips.length
    ? `
      <table>

        <thead>
          <tr>
            <th>Date</th>
            <th>Route</th>
            <th>Fare</th>
            <th>Commission</th>
            <th>Payout</th>
            <th>Profit</th>
          </tr>
        </thead>

        <tbody>
          ${trips.map(trip => `
            <tr>

              <td>
                ${esc(fmtTime(trip.completedAt))}
              </td>

              <td>
                ${esc(short(trip.pickup?.address))}

                ${
                  trip.drop
                    ? " → " + esc(short(trip.drop.address))
                    : ""
                }
              </td>

              <td>${inr(trip.finalFare)}</td>
              <td>${inr(trip.commission)}</td>
              <td>${inr(trip.payout)}</td>
              <td>${inr(trip.profit)}</td>

            </tr>
          `).join("")}
        </tbody>

      </table>
    `
    : `
      <div class="empty">
        No completed trips yet.
      </div>
    `;
}

// --------------------------------------------------
// DRIVER PROFILE
// --------------------------------------------------

function renderProfile() {
  if (!drv) return;

  const vehicleLabel =
    settings.vehicles[drv.vehicleType]?.label ||
    drv.vehicleType ||
    "Unknown";

  $("#profBox").innerHTML = `
    <h3>Profile &amp; vehicle</h3>

    <p>
      <b>${esc(drv.name || "")}</b>

      <br>

      ${esc(drv.email || "")}
      ·
      ${esc(drv.phone || "")}
    </p>

    <p>
      Vehicle:
      <b>${esc(drv.vehicleModel || "")}</b>

      (${esc(vehicleLabel)})

      · ${esc(drv.vehicleNo || "")}
    </p>

    <p>
      Licence:
      ${esc(drv.licenseNo || "")}

      (exp. ${esc(drv.licenseExpiry || "")})

      <br>

      RC: ${esc(drv.rcNo || "")}

      · Insurance: ${esc(drv.insuranceNo || "")}
    </p>

    <p>
      Document verification:
      ${badge(drv.approval)}
    </p>
  `;

  calc();
}

// --------------------------------------------------
// EARNINGS CALCULATOR
// --------------------------------------------------

function calc() {
  if (!drv || !settings) return;

  const fare = Number($("#cF")?.value) || 0;
  const distance = Number($("#cK")?.value) || 0;
  const other = Number($("#cO")?.value) || 0;

  const earnings = calcEarnings(
    settings,
    drv.vehicleType,
    fare,
    distance,
    other
  );

  $("#cOut").innerHTML = `
    <table>

      <tr>
        <td>Commission (${esc(settings.commissionPct)}%)</td>
        <td>${inr(earnings.commission)}</td>
      </tr>

      <tr>
        <td>Driver payout</td>
        <td>${inr(earnings.payout)}</td>
      </tr>

      <tr>
        <td>Fuel</td>
        <td>${inr(earnings.fuel)}</td>
      </tr>

      <tr>
        <td>Maintenance</td>
        <td>${inr(earnings.maint)}</td>
      </tr>

      <tr>
        <td>Other</td>
        <td>${inr(earnings.other)}</td>
      </tr>

      <tr>
        <td><b>Estimated profit</b></td>

        <td>
          <b class="gold">
            ${inr(earnings.profit)}
          </b>
        </td>
      </tr>

    </table>
  `;
}
