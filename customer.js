
import {
  $,
  esc,
  inr,
  ms,
  fmtTime,
  toast,
  badge,
  STATUS,
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
  addDoc,
  writeBatch,
  runTransaction,
  serverTimestamp,
  Timestamp
} from "./common.js";

import {
  mountBooking,
  baseMap,
  pin
} from "./booking.js";

import {
  SERVICES,
  expenseKm
} from "./fare.js";

// --------------------------------------------------
// INITIALIZATION
// --------------------------------------------------

initTheme();
initNav();
showConfigBanner();

let me = null;
let profile = null;
let settings = null;

let bookings = [];
let bookingsReady = false;
let busy = false;

let trackingMap = null;
let trackingMarkers = {};

let expiryTimer = null;

const STEPS = [
  "SEARCHING_DRIVER",
  "DRIVER_ASSIGNED",
  "DRIVER_ARRIVED",
  "TRIP_STARTED",
  "TRIP_COMPLETED"
];

const short = address =>
  String(address || "")
    .split(",")
    .slice(0, 2)
    .join(",");

const isTerminal = status =>
  TERMINAL.includes(status);

const activeBooking = () =>
  bookings.find(booking => !isTerminal(booking.status));

function statusText(status) {
  return STATUS[status] || status || "Unknown";
}

function validVehicle(vehicle) {
  return Boolean(settings?.vehicles?.[vehicle]);
}

function userRef() {
  return doc(db, "users", me.uid);
}

function bookingRef(id) {
  return doc(db, "bookings", id);
}

// --------------------------------------------------
// CUSTOMER DASHBOARD
// --------------------------------------------------

requireRole("customer", async (user, customerProfile) => {
  me = user;
  profile = customerProfile;

  try {
    settings = await loadSettings();

    if (!settings?.vehicles) {
      throw new Error("Vehicle settings could not be loaded.");
    }

    $("#hello").textContent =
      `Hi, ${(profile.name || "there").split(" ")[0]} 👋`;

    // Dashboard tabs.
    document.querySelectorAll(".tab").forEach(tab => {
      tab.addEventListener("click", () => {
        showPane(tab.dataset.p);
      });
    });

    // Restore a pending booking draft safely.
    let draft = null;

    try {
      draft = JSON.parse(
        sessionStorage.getItem("mt_draft") || "null"
      );
    } catch {
      try {
        sessionStorage.removeItem("mt_draft");
      } catch {
        // Session storage may be unavailable.
      }
    }

    try {
      sessionStorage.removeItem("mt_draft");
    } catch {
      // Continue without session storage.
    }

    const bookingRoot = $("#bookingRoot");

    if (!bookingRoot) {
      throw new Error("Booking form element was not found.");
    }

    mountBooking(bookingRoot, {
      settings,
      draft,
      bookLabel: "Request taxi",
      onBook: createBooking
    });

    // Profile details.
    $("#pN").value = profile.name || "";
    $("#pM").value = profile.phone || "";
    $("#pE").value = profile.email || "";

    $("#pSave").addEventListener("click", saveProfile);
    $("#sSend").addEventListener("click", sendSupport);

    // ------------------------------------------------
    // BOOKINGS LIVE LISTENER
    // ------------------------------------------------

    onSnapshot(
      query(
        collection(db, "bookings"),
        where("customerId", "==", me.uid)
      ),

      snapshot => {
        bookings = snapshot.docs
          .map(item => ({
            id: item.id,
            ...item.data()
          }))
          .sort(
            (a, b) =>
              ms(b.createdAt) - ms(a.createdAt)
          );

        bookingsReady = true;

        renderRide();
        renderHistory();

        // Release the customer's lock after a ride becomes
        // completed, cancelled, or unavailable.
        const linkedBooking = bookings.find(
          item => item.id === profile.activeBookingId
        );

        if (
          linkedBooking &&
          isTerminal(linkedBooking.status)
        ) {
          releaseCustomerLock(linkedBooking.id).catch(error => {
            console.error("Booking lock cleanup error:", error);
          });
        }
      },

      error => {
        console.error("Booking listener error:", error);

        toast(
          "Could not load bookings. Please refresh the page.",
          "error"
        );
      }
    );

    // ------------------------------------------------
    // SUPPORT LIVE LISTENER
    // ------------------------------------------------

    onSnapshot(
      query(
        collection(db, "support"),
        where("userId", "==", me.uid)
      ),

      snapshot => {
        const rows = snapshot.docs
          .map(item => item.data())
          .sort(
            (a, b) =>
              ms(b.createdAt) - ms(a.createdAt)
          );

        $("#supBox").innerHTML = rows.length
          ? rows.map(item => `
              <p>
                <b>${esc(item.subject)}</b>
                ${badge(item.status)}

                <br>

                <span class="muted">
                  ${esc(item.message)}
                </span>

                ${
                  item.reply
                    ? `<br><i>Reply: ${esc(item.reply)}</i>`
                    : ""
                }
              </p>
            `).join("")
          : "None yet.";
      },

      error => {
        console.error("Support listener error:", error);
        $("#supBox").textContent =
          "Could not load support requests.";
      }
    );

    // Check expired driver-search requests.
    expiryTimer = setInterval(expireCheck, 15000);

    if (draft) {
      toast(
        'Your trip details were restored. Tap "Request taxi" to continue.'
      );
    }

  } catch (error) {
    console.error("Customer dashboard initialization:", error);

    toast(
      "Could not initialize your dashboard: " + error.message,
      "error"
    );
  }
});

// --------------------------------------------------
// DASHBOARD TABS
// --------------------------------------------------

function showPane(id) {
  document.querySelectorAll(".pane").forEach(pane => {
    pane.classList.toggle("on", pane.id === id);
  });

  document.querySelectorAll(".tab").forEach(tab => {
    tab.classList.toggle("on", tab.dataset.p === id);
  });

  if (id === "pRide" && trackingMap) {
    setTimeout(() => {
      trackingMap.invalidateSize();
    }, 150);
  }
}

// --------------------------------------------------
// CUSTOMER BOOKING LOCK RECONCILIATION
// --------------------------------------------------

async function reconcileCustomerLock() {
  if (!me) {
    throw new Error("Your login session is unavailable.");
  }

  const customerRef = userRef();

  await runTransaction(db, async transaction => {
    const customerSnapshot = await transaction.get(customerRef);

    if (!customerSnapshot.exists()) {
      throw new Error("Customer profile was not found.");
    }

    const customer = customerSnapshot.data();
    const activeId = customer.activeBookingId;

    if (!activeId) {
      return;
    }

    if (typeof activeId !== "string") {
      throw new Error(
        "Your booking reference is invalid. Please contact support."
      );
    }

    const oldBookingRef = bookingRef(activeId);
    const oldBookingSnapshot = await transaction.get(oldBookingRef);

    if (!oldBookingSnapshot.exists()) {
      throw new Error(
        "Your previous booking could not be found. Please contact support."
      );
    }

    const oldBooking = oldBookingSnapshot.data();

    if (oldBooking.customerId !== me.uid) {
      throw new Error(
        "Your booking reference could not be verified. Please contact support."
      );
    }

    if (!isTerminal(oldBooking.status)) {
      throw new Error(
        "You already have an active ride. Complete or cancel it before booking again."
      );
    }

    // Only clear the lock when the linked booking is terminal.
    transaction.update(customerRef, {
      activeBookingId: null
    });
  });

  profile.activeBookingId = null;
}

// --------------------------------------------------
// RELEASE CUSTOMER LOCK AFTER TERMINAL STATUS
// --------------------------------------------------

async function releaseCustomerLock(id) {
  if (!me || !id) return;

  const customerRef = userRef();
  const rideRef = bookingRef(id);

  await runTransaction(db, async transaction => {
    // All reads happen before writes.
    const rideSnapshot = await transaction.get(rideRef);
    const customerSnapshot = await transaction.get(customerRef);

    if (!rideSnapshot.exists() || !customerSnapshot.exists()) {
      return;
    }

    const ride = rideSnapshot.data();
    const customer = customerSnapshot.data();

    if (
      ride.customerId !== me.uid ||
      !isTerminal(ride.status) ||
      customer.activeBookingId !== id
    ) {
      return;
    }

    transaction.update(customerRef, {
      activeBookingId: null
    });
  });

  if (profile.activeBookingId === id) {
    profile.activeBookingId = null;
  }
}

// --------------------------------------------------
// CREATE BOOKING
// --------------------------------------------------

async function createBooking(data) {
  if (busy) return;

  if (!bookingsReady) {
    toast(
      "Please wait while your booking information loads.",
      "error"
    );
    return;
  }

  if (activeBooking()) {
    toast("You already have an active ride.", "error");
    showPane("pRide");
    return;
  }

  if (!data?.pickup) {
    toast("Please select a pickup location.", "error");
    return;
  }

  if (
    !Number.isFinite(Number(data.pickup.lat)) ||
    !Number.isFinite(Number(data.pickup.lng)) ||
    !data.pickup.address
  ) {
    toast("Please select a valid pickup location.", "error");
    return;
  }

  if (!validVehicle(data.vehicle)) {
    toast("Please select a valid vehicle.", "error");
    return;
  }

  if (!SERVICES[data.service]) {
    toast("Please select a valid service.", "error");
    return;
  }

  const needsDestination =
    !["hourly", "fullday"].includes(data.service);

  if (
    needsDestination &&
    (
      !data.drop ||
      !Number.isFinite(Number(data.drop.lat)) ||
      !Number.isFinite(Number(data.drop.lng)) ||
      !data.drop.address
    )
  ) {
    toast("Please select a valid destination.", "error");
    return;
  }

  if (
    !Number.isFinite(Number(data.fare)) ||
    Number(data.fare) <= 0
  ) {
    toast("The estimated fare is invalid.", "error");
    return;
  }

  if (
    !Number.isFinite(Number(data.distanceKm)) ||
    Number(data.distanceKm) < 0
  ) {
    toast("The trip distance is invalid.", "error");
    return;
  }

  busy = true;

  try {
    // Clear only an old terminal booking lock.
    // A non-terminal booking prevents a new booking.
    await reconcileCustomerLock();

    // Check local booking data again after reconciliation.
    if (activeBooking()) {
      throw new Error(
        "You already have an active ride."
      );
    }

    const customerRef = userRef();
    const newBookingRef = doc(collection(db, "bookings"));

    const bookingData = {
      customerId: me.uid,
      customerName: profile.name,

      service: data.service,
      vehicle: data.vehicle,
      hours: data.hours ?? null,

      pickup: data.pickup,
      drop: needsDestination ? data.drop : null,

      distanceKm: Number(data.distanceKm),
      durationMin: Number(data.durationMin || 0),

      fare: Number(data.fare),

      expenseKm: expenseKm(
        settings,
        data.service,
        data.distanceKm,
        data.hours
      ),

      fareNote:
        "Estimate only; not an official or guaranteed price.",

      status: "SEARCHING_DRIVER",

      driverId: null,
      driverInfo: null,

      createdAt: serverTimestamp(),

      expiresAt: Timestamp.fromMillis(
        Date.now() +
        Number(settings.offerTimeoutMin || 5) * 60000
      )
    };

    const batch = writeBatch(db);

    // Create booking.
    batch.set(newBookingRef, bookingData);

    // Create protected contact information.
    batch.set(
      doc(
        db,
        "bookings",
        newBookingRef.id,
        "contact",
        "info"
      ),
      {
        name: profile.name,
        phone: profile.phone
      }
    );

    // Link the customer to the new booking.
    batch.update(customerRef, {
      activeBookingId: newBookingRef.id
    });

    // All three writes are atomic.
    await batch.commit();

    profile.activeBookingId = newBookingRef.id;

    toast(
      "Booking created. Searching for drivers...",
      "success"
    );

    showPane("pRide");

  } catch (error) {
    console.error("Booking creation error:", error);

    toast(
      "Could not create booking: " + error.message,
      "error"
    );

  } finally {
    busy = false;
  }
}

// --------------------------------------------------
// CANCEL BOOKING
// --------------------------------------------------

async function cancel(booking) {
  if (!booking?.id || !me) return;

  if (
    !["SEARCHING_DRIVER", "DRIVER_ASSIGNED"].includes(
      booking.status
    )
  ) {
    toast(
      "This ride can no longer be cancelled from your dashboard.",
      "error"
    );
    return;
  }

  if (!confirm("Cancel this ride?")) {
    return;
  }

  try {
    const rideRef = bookingRef(booking.id);
    const customerRef = userRef();

    await runTransaction(db, async transaction => {
      const rideSnapshot = await transaction.get(rideRef);
      const customerSnapshot = await transaction.get(customerRef);

      if (!rideSnapshot.exists()) {
        throw new Error("This booking no longer exists.");
      }

      const currentRide = rideSnapshot.data();

      if (currentRide.customerId !== me.uid) {
        throw new Error("You cannot cancel this booking.");
      }

      if (
        !["SEARCHING_DRIVER", "DRIVER_ASSIGNED"].includes(
          currentRide.status
        )
      ) {
        throw new Error(
          "The ride status has changed. Refresh and try again."
        );
      }

      transaction.update(rideRef, {
        status: "CANCELLED",
        cancelledAt: serverTimestamp(),
        cancelReason: "Cancelled by customer"
      });

      if (
        customerSnapshot.exists() &&
        customerSnapshot.data().activeBookingId === booking.id
      ) {
        transaction.update(customerRef, {
          activeBookingId: null
        });
      }
    });

    if (profile.activeBookingId === booking.id) {
      profile.activeBookingId = null;
    }

    toast("Ride cancelled.", "success");

  } catch (error) {
    console.error("Cancellation error:", error);

    toast(
      "Cannot cancel now: " + error.message,
      "error"
    );
  }
}

// --------------------------------------------------
// EXPIRED DRIVER SEARCH
// --------------------------------------------------

async function expireCheck() {
  if (!me || !bookingsReady || busy) return;

  const booking = activeBooking();

  if (
    !booking ||
    booking.status !== "SEARCHING_DRIVER" ||
    !booking.expiresAt
  ) {
    return;
  }

  if (ms(booking.expiresAt) > Date.now()) {
    return;
  }

  try {
    const rideRef = bookingRef(booking.id);
    const customerRef = userRef();

    await runTransaction(db, async transaction => {
      const rideSnapshot = await transaction.get(rideRef);
      const customerSnapshot = await transaction.get(customerRef);

      if (!rideSnapshot.exists()) return;

      const currentRide = rideSnapshot.data();

      if (
        currentRide.customerId !== me.uid ||
        currentRide.status !== "SEARCHING_DRIVER" ||
        !currentRide.expiresAt ||
        ms(currentRide.expiresAt) > Date.now()
      ) {
        return;
      }

      transaction.update(rideRef, {
        status: "NO_DRIVER_AVAILABLE",
        noDriverAt: serverTimestamp()
      });

      if (
        customerSnapshot.exists() &&
        customerSnapshot.data().activeBookingId === booking.id
      ) {
        transaction.update(customerRef, {
          activeBookingId: null
        });
      }
    });

    if (profile.activeBookingId === booking.id) {
      profile.activeBookingId = null;
    }

    toast(
      "No driver accepted this request. You can try again.",
      "error"
    );

  } catch (error) {
    console.error("Booking expiry error:", error);
  }
}

// --------------------------------------------------
// RIDE DISPLAY
// --------------------------------------------------

function renderRide() {
  const box = $("#rideBox");
  const mapElement = $("#trkMap");

  if (!box || !mapElement) return;

  const booking =
    activeBooking() ||
    bookings.find(
      item =>
        Date.now() - ms(item.createdAt) < 2 * 3600 * 1000
    );

  if (!booking) {
    box.innerHTML = `
      <div class="empty">
        No active ride. Use the Book tab to request a taxi.
      </div>
    `;

    mapElement.hidden = true;

    return;
  }

  const index = STEPS.indexOf(booking.status);
  const driver = booking.driverInfo;

  const vehicleLabel =
    settings.vehicles[booking.vehicle]?.label ||
    booking.vehicle ||
    "Vehicle";

  const serviceLabel =
    SERVICES[booking.service] ||
    booking.service ||
    "Taxi";

  box.innerHTML = `
    <div
      class="row wrapf"
      style="justify-content:space-between">

      <h3 style="margin:0">
        ${esc(serviceLabel)} · ${esc(vehicleLabel)}
      </h3>

      ${badge(booking.status)}
    </div>

    ${
      index >= 0
        ? `
          <div class="steps">
            ${STEPS.map((step, stepIndex) => `
              <div class="step ${stepIndex <= index ? "done" : ""}">
                ${esc(statusText(step))}
              </div>
            `).join("")}
          </div>
        `
        : ""
    }

    <p>
      📍 ${esc(short(booking.pickup?.address))}

      <br>

      🏁 ${
        esc(
          booking.drop
            ? short(booking.drop.address)
            : "Rental — no fixed destination"
        )
      }
    </p>

    <p>
      Estimated fare:
      <b class="gold">${inr(booking.fare)}</b>

      ${
        booking.distanceKm
          ? `· ${esc(booking.distanceKm)} km · ~${esc(booking.durationMin)} min`
          : ""
      }

      <span class="muted">(estimate)</span>
    </p>

    ${
      booking.status === "SEARCHING_DRIVER"
        ? `
          <p>
            <span class="spin"></span>
            Looking for approved drivers...
          </p>
        `
        : ""
    }

    ${
      booking.status === "NO_DRIVER_AVAILABLE"
        ? `
          <p class="gold">
            <b>No driver is available right now.</b>
            Please try again shortly.
          </p>
        `
        : ""
    }

    ${
      booking.status === "TRIP_COMPLETED"
        ? `
          <p>
            Trip complete.
            Final fare:
            <b>${inr(booking.finalFare ?? booking.fare)}</b>
          </p>
        `
        : ""
    }

    ${
      driver && !isTerminal(booking.status)
        ? `
          <div class="card" style="margin:10px 0">
            <b>Your driver</b>

            <br>

            ${esc(driver.name || "Driver")}

            ${
              driver.phone
                ? ` · <a href="tel:${esc(driver.phone)}">${esc(driver.phone)}</a>`
                : ""
            }

            <br>

            ${esc(driver.vehicleModel || "")}

            <b>${esc(driver.vehicleNo || "")}</b>
          </div>
        `
        : ""
    }

    ${
      ["SEARCHING_DRIVER", "DRIVER_ASSIGNED"].includes(
        booking.status
      )
        ? `
          <button class="btn bad" id="cancelBtn">
            Cancel ride
          </button>
        `
        : ""
    }
  `;

  $("#cancelBtn")?.addEventListener("click", () => {
    cancel(booking);
  });

  const live = [
    "DRIVER_ASSIGNED",
    "DRIVER_ARRIVED",
    "TRIP_STARTED"
  ].includes(booking.status);

  mapElement.hidden = !booking.pickup;

  if (booking.pickup) {
    track(booking, live);
  }
}

// --------------------------------------------------
// LIVE MAP
// --------------------------------------------------

function track(booking, live) {
  if (!trackingMap) {
    trackingMap = baseMap($("#trkMap"));
  }

  function setMarker(key, point, color) {
    if (
      !point ||
      !Number.isFinite(Number(point.lat)) ||
      !Number.isFinite(Number(point.lng))
    ) {
      return;
    }

    const lat = Number(point.lat);
    const lng = Number(point.lng);

    if (trackingMarkers[key]) {
      trackingMarkers[key].setLatLng([lat, lng]);
    } else {
      trackingMarkers[key] = L.marker(
        [lat, lng],
        {
          icon: pin(color)
        }
      ).addTo(trackingMap);
    }
  }

  setMarker(
    "pickup",
    booking.pickup,
    "#22c55e"
  );

  setMarker(
    "destination",
    booking.drop,
    "#ef4444"
  );

  if (live) {
    setMarker(
      "driver",
      booking.driverLoc,
      "#f5b400"
    );
  } else if (trackingMarkers.driver) {
    trackingMap.removeLayer(trackingMarkers.driver);
    delete trackingMarkers.driver;
  }

  const points = Object.values(trackingMarkers).map(
    marker => marker.getLatLng()
  );

  if (points.length) {
    trackingMap.fitBounds(
      L.latLngBounds(points).pad(0.3),
      {
        maxZoom: 15
      }
    );
  }

  setTimeout(() => {
    trackingMap.invalidateSize();
  }, 100);
}

// --------------------------------------------------
// BOOKING HISTORY
// --------------------------------------------------

function renderHistory() {
  const historyBox = $("#histBox");

  if (!historyBox) return;

  historyBox.innerHTML = bookings.length
    ? `
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Service</th>
            <th>Route</th>
            <th>Fare</th>
            <th>Status</th>
          </tr>
        </thead>

        <tbody>
          ${bookings.map(booking => `
            <tr>
              <td>${esc(fmtTime(booking.createdAt))}</td>

              <td>
                ${esc(SERVICES[booking.service] || booking.service)}
                <br>
                <small class="muted">
                  ${esc(booking.vehicle)}
                </small>
              </td>

              <td>
                ${esc(short(booking.pickup?.address))}

                ${
                  booking.drop
                    ? " → " + esc(short(booking.drop.address))
                    : ""
                }
              </td>

              <td>
                ${inr(booking.finalFare ?? booking.fare)}
              </td>

              <td>
                ${badge(booking.status)}
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `
    : `
      <div class="empty">
        No bookings yet.
      </div>
    `;
}

// --------------------------------------------------
// PROFILE UPDATE
// --------------------------------------------------

async function saveProfile() {
  const name = $("#pN").value.trim();
  const phone = $("#pM").value.trim();

  if (
    name.length < 2 ||
    !/^[6-9]\d{9}$/.test(phone)
  ) {
    toast(
      "Enter a valid name and 10-digit mobile number.",
      "error"
    );
    return;
  }

  try {
    const batch = writeBatch(db);

    batch.update(
      userRef(),
      {
        name,
        phone
      }
    );

    await batch.commit();

    profile.name = name;
    profile.phone = phone;

    $("#hello").textContent =
      `Hi, ${name.split(" ")[0]} 👋`;

    toast("Profile updated.", "success");

  } catch (error) {
    console.error("Profile update error:", error);
    toast(error.message, "error");
  }
}

// --------------------------------------------------
// SUPPORT REQUEST
// --------------------------------------------------

async function sendSupport() {
  const subject = $("#sS").value.trim();
  const message = $("#sM").value.trim();

  if (
    subject.length < 3 ||
    message.length < 5
  ) {
    toast(
      "Please fill in the subject and message.",
      "error"
    );
    return;
  }

  try {
    await addDoc(
      collection(db, "support"),
      {
        userId: me.uid,
        name: profile.name,
        email: profile.email,
        phone: profile.phone,

        subject,
        message,

        status: "OPEN",
        createdAt: serverTimestamp()
      }
    );

    $("#sS").value = "";
    $("#sM").value = "";

    toast("Support request sent.", "success");

  } catch (error) {
    console.error("Support request error:", error);
    toast(error.message, "error");
  }
}
