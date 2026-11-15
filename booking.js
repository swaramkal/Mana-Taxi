
import { $, esc, inr, toast } from "./common.js";
import {
  calcFare,
  VEHICLES,
  SERVICES,
  NEEDS_DEST
} from "./fare.js";

export const VIZAG = [17.6868, 83.2185];

const NOM = "https://nominatim.openstreetmap.org";

// --------------------------------------------------
// LOCATION SEARCH
// --------------------------------------------------

export async function geocode(query) {
  const params = new URLSearchParams({
    format: "jsonv2",
    limit: "5",
    countrycodes: "in",
    viewbox: "82.9,17.95,83.5,17.45",
    q: query
  });

  const response = await fetch(
    `${NOM}/search?${params}`,
    {
      headers: {
        "Accept-Language": "en"
      }
    }
  );

  if (!response.ok) {
    throw new Error("Address search failed. Try again.");
  }

  const results = await response.json();

  return results.map(item => ({
    address: item.display_name,
    lat: Number(item.lat),
    lng: Number(item.lon)
  }));
}

// --------------------------------------------------
// REVERSE GEOCODING
// --------------------------------------------------

export async function reverse(lat, lng) {
  try {
    const params = new URLSearchParams({
      format: "jsonv2",
      lat: String(lat),
      lon: String(lng)
    });

    const response = await fetch(
      `${NOM}/reverse?${params}`,
      {
        headers: {
          "Accept-Language": "en"
        }
      }
    );

    if (!response.ok) {
      throw new Error("Address lookup failed");
    }

    const result = await response.json();

    return result.display_name ||
      `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

  } catch {
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
}

// --------------------------------------------------
// ROAD ROUTING
// --------------------------------------------------

export async function route(start, end) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${start.lng},${start.lat};${end.lng},${end.lat}` +
    "?overview=full&geometries=geojson";

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Routing service is unavailable.");
  }

  const result = await response.json();

  if (
    result.code !== "Ok" ||
    !result.routes ||
    !result.routes.length
  ) {
    throw new Error("No road route found.");
  }

  const selectedRoute = result.routes[0];

  return {
    km: selectedRoute.distance / 1000,
    min: selectedRoute.duration / 60,

    coords: selectedRoute.geometry.coordinates.map(
      coordinate => [
        coordinate[1],
        coordinate[0]
      ]
    )
  };
}

// --------------------------------------------------
// MAP INITIALIZATION
// --------------------------------------------------

export function baseMap(element) {
  if (!window.L) {
    throw new Error("Map service is not available.");
  }

  const map = L.map(element).setView(VIZAG, 12);

  L.tileLayer(
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors"
    }
  ).addTo(map);

  return map;
}

export const pin = color =>
  L.divIcon({
    className: "",
    html: `<div class="pin" style="background:${color}"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 22]
  });

// --------------------------------------------------
// BOOKING WIDGET
// --------------------------------------------------

export function mountBooking(
  root,
  {
    settings,
    onBook,
    bookLabel = "Book a Taxi",
    draft = null
  }
) {
  if (!root) {
    throw new Error("Booking container not found.");
  }

  if (!settings?.vehicles) {
    throw new Error("Vehicle fare settings are unavailable.");
  }

  if (typeof onBook !== "function") {
    throw new Error("Booking handler is unavailable.");
  }

  root.innerHTML = `
    <div class="bk-grid">

      <div>

        <div class="chips" id="svc">
          ${Object.entries(SERVICES).map(([key, label]) => `
            <button
              type="button"
              class="chip"
              data-s="${esc(key)}">
              ${esc(label)}
            </button>
          `).join("")}
        </div>

        <label for="pu">Pickup location</label>

        <div class="row">
          <input
            id="pu"
            placeholder="Search pickup (e.g. RK Beach)"
            autocomplete="off">

          <button type="button" class="btn sm" id="puS">
            Search
          </button>
        </div>

        <div id="puR" class="sugg"></div>

        <div id="drBox">

          <label for="dr">Destination</label>

          <div class="row">
            <input
              id="dr"
              placeholder="Search destination"
              autocomplete="off">

            <button type="button" class="btn sm" id="drS">
              Search
            </button>
          </div>

          <div id="drR" class="sugg"></div>

        </div>

        <div id="hrBox" hidden>

          <label for="hrs">Hours (hourly rental)</label>

          <select id="hrs">
            ${Array.from({ length: 12 }, (_, index) => `
              <option value="${index + 1}">
                ${index + 1} hour${index ? "s" : ""}
              </option>
            `).join("")}
          </select>

        </div>

        <div class="row wrapf" style="margin-top:8px">

          <button type="button" class="btn ghost sm" id="loc">
            📍 My location
          </button>

          <button type="button" class="btn ghost sm" id="pPu">
            Pick pickup on map
          </button>

          <button type="button" class="btn ghost sm" id="pDr">
            Pick destination on map
          </button>

        </div>

        <div class="sum" id="sum" aria-live="polite"></div>

        <div class="veh" id="veh"></div>

        <p class="note">
          Fares are estimates using configurable sample rates.
          Actual fares may differ. Distance is calculated using
          the available road-routing service.
        </p>

        <button
          type="button"
          class="btn gold block"
          id="book">
          ${esc(bookLabel)}
        </button>

        <p class="note">
          Customer booking is free. No booking or
          confirmation fee is charged.
        </p>

      </div>

      <div
        id="map"
        class="map"
        aria-label="Pickup and destination map">
      </div>

    </div>
  `;

  // ------------------------------------------------
  // STATE
  // ------------------------------------------------

  const state = {
    service: "city",
    vehicle: "sedan",
    hours: 2,

    pu: null,
    dr: null,

    rt: null,
    pick: null,

    tok: 0
  };

  const all = selector =>
    [...root.querySelectorAll(selector)];

  const map = baseMap($("#map", root));

  setTimeout(() => {
    map.invalidateSize();
  }, 250);

  const markers = {};

  let routeLine = null;

  // ------------------------------------------------
  // MAP MARKERS
  // ------------------------------------------------

  function setPoint(kind, point, fit = true) {
    if (
      !point ||
      !Number.isFinite(point.lat) ||
      !Number.isFinite(point.lng)
    ) {
      return;
    }

    state[kind] = point;

    const input = $(
      kind === "pu" ? "#pu" : "#dr",
      root
    );

    input.value = point.address;

    if (markers[kind]) {
      markers[kind].setLatLng([
        point.lat,
        point.lng
      ]);
    } else {
      markers[kind] = L.marker(
        [point.lat, point.lng],
        {
          draggable: true,
          icon: pin(
            kind === "pu" ? "#22c55e" : "#ef4444"
          )
        }
      ).addTo(map);

      markers[kind].on("dragend", async () => {
        const position = markers[kind].getLatLng();

        const address = await reverse(
          position.lat,
          position.lng
        );

        setPoint(
          kind,
          {
            lat: position.lat,
            lng: position.lng,
            address
          },
          false
        );
      });
    }

    if (fit && !(state.pu && state.dr)) {
      map.setView(
        [point.lat, point.lng],
        15
      );
    }

    refresh();
  }

  // ------------------------------------------------
  // CLEAR A LOCATION
  // ------------------------------------------------

  function clearPoint(kind) {
    state[kind] = null;

    if (markers[kind]) {
      map.removeLayer(markers[kind]);
      delete markers[kind];
    }

    refresh();
  }

  // ------------------------------------------------
  // ROUTE AND FARE REFRESH
  // ------------------------------------------------

  async function refresh() {
    const token = ++state.tok;

    state.rt = null;

    if (routeLine) {
      map.removeLayer(routeLine);
      routeLine = null;
    }

    const needsDestination = NEEDS_DEST(state.service);

    if (
      needsDestination &&
      state.pu &&
      state.dr
    ) {
      $("#sum", root).innerHTML =
        '<span class="spin"></span> Calculating road route...';

      try {
        const result = await route(
          state.pu,
          state.dr
        );

        if (token !== state.tok) return;

        state.rt = result;

        routeLine = L.polyline(
          result.coords,
          {
            color: "#f5b400",
            weight: 5
          }
        ).addTo(map);

        map.fitBounds(
          routeLine.getBounds(),
          {
            padding: [30, 30]
          }
        );

      } catch (error) {
        if (token !== state.tok) return;

        toast(
          error.message + " Fare cannot be calculated.",
          "error"
        );
      }
    }

    if (token === state.tok) {
      render();
    }
  }

  // ------------------------------------------------
  // VALIDATION AND FARE ESTIMATION
  // ------------------------------------------------

  function ready() {
    return Boolean(
      state.pu &&
      (
        !NEEDS_DEST(state.service) ||
        state.rt
      )
    );
  }

  function estimate(vehicle) {
    if (!ready()) return "—";

    try {
      const fare = calcFare(
        settings,
        vehicle,
        state.service,
        {
          distanceKm: state.rt?.km || 0,
          hours: state.hours
        }
      );

      if (!Number.isFinite(Number(fare))) {
        return "Unavailable";
      }

      return inr(fare);

    } catch (error) {
      console.error("Fare calculation error:", error);
      return "Unavailable";
    }
  }

  // ------------------------------------------------
  // RENDER WIDGET
  // ------------------------------------------------

  function render() {
    all(".chip").forEach(button => {
      button.classList.toggle(
        "on",
        button.dataset.s === state.service
      );
    });

    $("#drBox", root).hidden =
      !NEEDS_DEST(state.service);

    $("#hrBox", root).hidden =
      state.service !== "hourly";

    const summary = $("#sum", root);

    if (state.rt) {
      summary.innerHTML = `
        <span>
          🛣 ${state.rt.km.toFixed(1)} km
        </span>

        <span>
          ⏱ ${Math.round(state.rt.min)} min
        </span>
      `;
    } else if (state.service === "fullday") {
      summary.innerHTML = "<span>12-hour package</span>";
    } else {
      summary.innerHTML = "";
    }

    $("#veh", root).innerHTML = VEHICLES.map(vehicle => {
      const vehicleSettings =
        settings.vehicles[vehicle] || {};

      return `
        <button
          type="button"
          class="vcard ${state.vehicle === vehicle ? "on" : ""}"
          data-v="${esc(vehicle)}">

          <b>${esc(estimate(vehicle))}</b>

          ${esc(vehicleSettings.label || vehicle)}

          <br>

          <small>
            ${esc(vehicleSettings.seats ?? "—")} seats
          </small>

        </button>
      `;
    }).join("");

    all(".vcard").forEach(button => {
      button.addEventListener("click", () => {
        state.vehicle = button.dataset.v;
        render();
      });
    });

    $("#book", root).disabled = !ready();
  }

  // ------------------------------------------------
  // SERVICE SELECTION
  // ------------------------------------------------

  all(".chip").forEach(button => {
    button.addEventListener("click", () => {
      state.service = button.dataset.s;
      refresh();
    });
  });

  // ------------------------------------------------
  // HOURLY RENTAL
  // ------------------------------------------------

  $("#hrs", root).value = state.hours;

  $("#hrs", root).addEventListener("change", event => {
    const hours = Number(event.target.value);

    if (Number.isInteger(hours) && hours >= 1 && hours <= 12) {
      state.hours = hours;
      render();
    }
  });

  // ------------------------------------------------
  // LOCATION INPUT EDITING
  // ------------------------------------------------

  for (const kind of ["pu", "dr"]) {
    const input = $("#" + kind, root);
    const resultsBox = $("#" + kind + "R", root);

    input.addEventListener("input", () => {
      resultsBox.innerHTML = "";

      const selected = state[kind];

      // Prevent stale coordinates when text changes.
      if (
        selected &&
        input.value.trim() !== selected.address
      ) {
        clearPoint(kind);
      }
    });

    // ----------------------------------------------
    // SEARCH LOCATION
    // ----------------------------------------------

    const search = async () => {
      const query = input.value.trim();

      if (query.length < 3) {
        toast("Type at least 3 characters.", "error");
        return;
      }

      resultsBox.innerHTML =
        '<span class="spin"></span>';

      try {
        const results = await geocode(query);

        resultsBox.innerHTML = "";

        if (!results.length) {
          resultsBox.innerHTML =
            '<div class="note">No results found. Try another address or use the map.</div>';

          return;
        }

        results.forEach(result => {
          const button = document.createElement("button");

          button.type = "button";
          button.textContent = result.address;

          button.addEventListener("click", () => {
            resultsBox.innerHTML = "";
            setPoint(kind, result);
          });

          resultsBox.appendChild(button);
        });

      } catch (error) {
        resultsBox.innerHTML = "";
        toast(error.message, "error");
      }
    };

    $("#" + kind + "S", root)
      .addEventListener("click", search);

    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        search();
      }
    });
  }

  // ------------------------------------------------
  // MAP PICKING
  // ------------------------------------------------

  $("#pPu", root).addEventListener("click", () => {
    state.pick = "pu";
    toast("Tap the map to set your pickup location.");
  });

  $("#pDr", root).addEventListener("click", () => {
    if (!NEEDS_DEST(state.service)) {
      toast(
        "This service does not require a destination.",
        "info"
      );
      return;
    }

    state.pick = "dr";

    toast("Tap the map to set your destination.");
  });

  map.on("click", async event => {
    const kind =
      state.pick || (!state.pu ? "pu" : "dr");

    if (
      kind === "dr" &&
      !NEEDS_DEST(state.service)
    ) {
      return;
    }

    state.pick = null;

    const lat = event.latlng.lat;
    const lng = event.latlng.lng;

    const address = await reverse(lat, lng);

    setPoint(
      kind,
      {
        lat,
        lng,
        address
      },
      false
    );
  });

  // ------------------------------------------------
  // CURRENT LOCATION
  // ------------------------------------------------

  $("#loc", root).addEventListener("click", () => {
    if (!navigator.geolocation) {
      toast(
        "Location is not supported on this device.",
        "error"
      );
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async position => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;

        const address = await reverse(lat, lng);

        setPoint(
          "pu",
          {
            lat,
            lng,
            address
          }
        );
      },

      () => {
        toast(
          "Location permission denied. Search or tap the map instead.",
          "error"
        );
      },

      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 30000
      }
    );
  });

  // ------------------------------------------------
  // BOOKING HANDOFF
  // ------------------------------------------------

  $("#book", root).addEventListener("click", () => {
    if (!ready()) {
      toast(
        NEEDS_DEST(state.service)
          ? "Choose pickup and destination first."
          : "Choose a pickup location first.",
        "error"
      );

      return;
    }

    const fare = calcFare(
      settings,
      state.vehicle,
      state.service,
      {
        distanceKm: state.rt?.km || 0,
        hours: state.hours
      }
    );

    if (!Number.isFinite(Number(fare)) || fare <= 0) {
      toast("Unable to calculate the fare. Please try again.", "error");
      return;
    }

    const bookingData = {
      service: state.service,
      vehicle: state.vehicle,
      hours: state.hours,

      pickup: {
        ...state.pu
      },

      drop: NEEDS_DEST(state.service)
        ? { ...state.dr }
        : null,

      distanceKm: state.rt
        ? Number(state.rt.km.toFixed(2))
        : 0,

      durationMin: state.rt
        ? Math.round(state.rt.min)
        : 0,

      fare: Number(fare)
    };

    try {
      onBook(bookingData);
    } catch (error) {
      console.error("Booking handoff error:", error);

      toast(
        "Could not prepare your booking. Please try again.",
        "error"
      );
    }
  });

  // ------------------------------------------------
  // RESTORE DRAFT
  // ------------------------------------------------

  if (draft) {
    if (SERVICES[draft.service]) {
      state.service = draft.service;
    }

    if (VEHICLES.includes(draft.vehicle)) {
      state.vehicle = draft.vehicle;
    }

    if (
      Number.isInteger(Number(draft.hours)) &&
      Number(draft.hours) >= 1 &&
      Number(draft.hours) <= 12
    ) {
      state.hours = Number(draft.hours);
    }

    $("#hrs", root).value = state.hours;

    if (draft.pickup) {
      setPoint("pu", draft.pickup);
    }

    if (draft.drop) {
      setPoint("dr", draft.drop);
    }
  }

  render();

  return {
    map,
    state
  };
}
