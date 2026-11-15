# MANA TAXI SERVICE — "Your Ride, Your Way."

Real taxi-booking web app for Visakhapatnam (expandable): **Customer, Driver and Admin portals**, live ride dispatch, fare engine, earnings reports.

**Stack:** plain HTML/CSS/JS (ES modules) · **Firebase Auth + Firestore + Hosting** · Leaflet/OpenStreetMap · Nominatim (search) · OSRM (road route).

Runs on the **free Spark plan** (no Cloud Functions, no Storage needed).

---

## 1. Firebase setup (once, ~10 min)

1. Create/choose a project (e.g. `mana-taxi-service`).
2. **Build → Authentication → Sign-in method → enable Email/Password.**
3. **Build → Firestore Database → Create database** (production mode, region `asia-south1` Mumbai recommended).
4. **Project settings → Your apps → Web (`</>`)** → register app.
5. Copy the `firebaseConfig` values into `public/js/firebase-config.js` (already filled with a sample project — replace with yours if different).
6. Put your project id in `.firebaserc` (already set to `mana-taxi-service`).

---

## 2. Deploy

```bash
# Install tools (once)
npm install -g firebase-tools

# Login
firebase login

# Test the fare engine
npm test

# Deploy hosting + security rules
firebase deploy --only hosting,firestore:rules
```

Site URL: `https://YOUR_PROJECT_ID.web.app`

Also add that domain under **Authentication → Settings → Authorized domains** if login complains.

---

## 3. GitHub

```bash
git init
git add .
git commit -m "MANA TAXI: full Firebase version"
git branch -M main
git remote add origin https://github.com/YOU/mana-taxi.git
git push -u origin main
```

No secrets are in the repo (the Firebase web config is a public identifier; security is enforced by `firestore.rules`).

---

## 4. Create the first Admin (owner only — never via the app)

1. Console → Authentication → **Add user** (your email + strong password). Copy its **User UID**.
2. Console → Firestore → **Start collection `admins`** → Document ID = that UID → add any field (e.g. `owner: true`).
3. Log in at `/login` (footer "Admin Login") → you are redirected to the Admin dashboard.
4. (Optional) In Admin → Fare settings press Save once to create `settings/fare`; until then built-in defaults are used.

---

## 5. How it works

- **Booking**: customer picks pickup/destination (search, tap map, drag markers, GPS) → OSRM **road distance** → fare per Mini/Sedan/SUV → booking saved in Firestore with status `SEARCHING_DRIVER`. Duplicate active bookings are blocked by a rule-enforced lock.
- **Dispatch**: every **approved + online** driver with the right vehicle type within **5 km** (editable) sees the request. **First Accept wins**: a Firestore *transaction* + security rule only allow `SEARCHING_DRIVER → DRIVER_ASSIGNED` once, and only if the driver has no active ride. After **25 min** (editable) the booking becomes `NO_DRIVER_AVAILABLE`; admin can also assign manually.
- **Trip states**: SEARCHING_DRIVER → DRIVER_ASSIGNED → DRIVER_ARRIVED → TRIP_STARTED → TRIP_COMPLETED (+ CANCELLED / NO_DRIVER_AVAILABLE). Invalid jumps are rejected by the rules.
- **Fares & earnings**: all rates are editable in Admin → Fare settings. Waiting: 5 min free then ₹2/min. Payout = fare − commission; profit = payout − fuel − maintenance − other.
- **Payments**: none collected (free booking). No card data is stored.

---

## 6. Project structure

```
mana-taxi/
├── .firebaserc
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
├── package.json
├── README.md
├── public/
│   ├── index.html          # Landing page
│   ├── login.html          # Customer / Driver / Admin login
│   ├── customer.html       # Customer portal
│   ├── driver.html         # Driver portal
│   ├── admin.html          # Admin dashboard
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── firebase-config.js
│       ├── common.js
│       ├── fare.js
│       ├── booking.js
│       ├── home.js
│       ├── auth.js
│       ├── customer.js
│       ├── driver.js
│       └── admin.js
└── tests/
    └── fare.test.mjs
```

---

## 7. Known limits of the free, no-server design

- Fare/earnings numbers are computed in the browser; rules only sanity-check them. Move calculation into a Cloud Function before real money flows.
- **No push/SMS/email notifications**. Status changes appear live in the app only.
- **No document image upload** (Firebase Storage needs Blaze). Drivers submit licence/RC/insurance *numbers*.
- Dispatch is client-driven: offers show while a driver's app is open and online.
- Public map services (OSM, Nominatim, OSRM demo) have usage policies — suitable for light use / demos.
- Footer contact details and Terms/Privacy/Refund pages are placeholders.

---

## 8. Quick test flow

1. Register a customer account.
2. Register a driver account.
3. Login as admin → approve the driver.
4. Driver goes online.
5. Customer books a ride.
6. Driver accepts → arrives → starts → completes.
7. Check earnings and reports in Admin.

If the console shows `permission-denied`, copy the exact message — it points to the rule that needs adjustment.
