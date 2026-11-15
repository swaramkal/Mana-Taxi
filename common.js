
import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import {
  getAuth,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  getFirestore,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";
import { DEFAULT_SETTINGS, mergeSettings } from "./fare.js";

// Re-export Firebase functions used by the other project modules.
export * from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
export * from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Firebase initialization
export const configured = Boolean(
  firebaseConfig?.apiKey &&
  firebaseConfig?.projectId &&
  !/PASTE|YOUR_/i.test(
    `${firebaseConfig.apiKey}${firebaseConfig.projectId}`
  )
);

export const app = configured
  ? initializeApp(firebaseConfig)
  : null;

export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;

// Common helpers
export const $ = (selector, root = document) =>
  root.querySelector(selector);

export const $$ = (selector, root = document) =>
  [...root.querySelectorAll(selector)];

export const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);

export const inr = (amount) =>
  "₹" + Math.round(Number(amount) || 0).toLocaleString("en-IN");

export const ms = (timestamp) =>
  timestamp?.toMillis
    ? timestamp.toMillis()
    : typeof timestamp === "number"
      ? timestamp
      : Date.now();

export const fmtTime = (timestamp) =>
  timestamp?.toMillis
    ? new Date(timestamp.toMillis()).toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "short"
      })
    : "—";

// Booking and trip statuses
export const STATUS = {
  PENDING: "Pending",
  SEARCHING_DRIVER: "Searching for driver",
  DRIVER_ASSIGNED: "Driver assigned",
  DRIVER_ARRIVED: "Driver arrived",
  TRIP_STARTED: "Trip started",
  TRIP_COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_DRIVER_AVAILABLE: "No driver available"
};

export const TERMINAL = [
  "TRIP_COMPLETED",
  "CANCELLED",
  "NO_DRIVER_AVAILABLE"
];

// Dashboard destinations
export const HOME = {
  admin: "admin.html",
  driver: "driver.html",
  customer: "customer.html"
};

export const badge = (status) => {
  const success = [
    "TRIP_COMPLETED",
    "APPROVED",
    "active"
  ];

  const danger = [
    "CANCELLED",
    "NO_DRIVER_AVAILABLE",
    "REJECTED",
    "SUSPENDED",
    "suspended"
  ];

  const className = success.includes(status)
    ? "ok"
    : danger.includes(status)
      ? "bad"
      : "";

  return `<span class="badge ${className}">${esc(
    STATUS[status] || status
  )}</span>`;
};

// Notification helper
export function toast(message, type = "info") {
  const notification = document.createElement("div");

  notification.className = `toast ${type}`;
  notification.setAttribute("role", "status");
  notification.textContent = message;

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.remove();
  }, type === "error" ? 6000 : 3500);
}

// Theme and mobile navigation
export function initTheme() {
  const setTheme = (theme) => {
    const selectedTheme =
      theme === "light" ? "light" : "dark";

    document.documentElement.dataset.theme = selectedTheme;

    try {
      localStorage.setItem("mt_theme", selectedTheme);
    } catch {
      // Theme still works for the current page.
    }
  };

  let savedTheme = "dark";

  try {
    savedTheme = localStorage.getItem("mt_theme") || "dark";
  } catch {
    // Use the default theme.
  }

  setTheme(savedTheme);

  $("#themeBtn")?.addEventListener("click", () => {
    const currentTheme =
      document.documentElement.dataset.theme;

    setTheme(currentTheme === "dark" ? "light" : "dark");
  });

  const menuButton = $("#menuBtn");
  const links = $("#links");

  menuButton?.addEventListener("click", () => {
    const isOpen = links?.classList.toggle("open");

    menuButton.setAttribute(
      "aria-expanded",
      String(Boolean(isOpen))
    );
  });

  links?.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      links.classList.remove("open");
      menuButton?.setAttribute("aria-expanded", "false");
    });
  });
}

// Firebase configuration warning
export function showConfigBanner() {
  if (configured) return;

  const banner = document.createElement("div");

  banner.className = "banner";
  banner.textContent =
    "Firebase is not configured. Check public/js/firebase-config.js.";

  document.body.prepend(banner);
}

// Fare and application settings
export async function loadSettings() {
  if (!db) {
    return mergeSettings({});
  }

  try {
    const settingsRef = doc(db, "settings", "fare");
    const settingsSnapshot = await getDoc(settingsRef);

    return mergeSettings(
      settingsSnapshot.exists()
        ? settingsSnapshot.data()
        : {}
    );
  } catch (error) {
    console.error("Settings could not be loaded:", error);
    return mergeSettings({});
  }
}

// Read the user's role from Firestore.
// The Firestore security rules must protect role changes.
export async function getRole(user) {
  if (!db || !user?.uid) return null;

  const adminRef = doc(db, "admins", user.uid);
  const adminSnapshot = await getDoc(adminRef);

  if (adminSnapshot.exists()) {
    return {
      role: "admin",
      profile: {
        name: user.displayName || user.email,
        email: user.email,
        status: "active"
      }
    };
  }

  const userRef = doc(db, "users", user.uid);
  const userSnapshot = await getDoc(userRef);

  if (!userSnapshot.exists()) return null;

  const profile = userSnapshot.data();

  if (!["customer", "driver"].includes(profile.role)) {
    return null;
  }

  return {
    role: profile.role,
    profile
  };
}

// Protect dashboard pages by account role.
export function requireRole(expectedRole, callback) {
  if (!auth || !db) {
    showConfigBanner();
    return;
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      location.replace("login.html");
      return;
    }

    try {
      let account = await getRole(user);

      if (!account) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        account = await getRole(user);
      }

      if (!account) {
        await signOut(auth);
        location.replace("login.html");
        return;
      }

      if (account.role !== expectedRole) {
        location.replace(
          HOME[account.role] || "index.html"
        );
        return;
      }

      if (
        ["suspended", "SUSPENDED"].includes(
          account.profile?.status
        )
      ) {
        await signOut(auth);
        alert(
          "Your account is suspended. Please contact support."
        );
        location.replace("login.html");
        return;
      }

      callback(user, account.profile);
    } catch (error) {
      console.error("Role verification failed:", error);
      toast(
        "Could not verify your account. Please try again.",
        "error"
      );
    }
  });
}

// Logout
export function logout() {
  if (!auth) {
    location.href = "index.html";
    return Promise.resolve();
  }

  return signOut(auth).then(() => {
    location.href = "index.html";
  });
}

// Main website navigation authentication area
export function initNav() {
  const slot = $("#navAuth");

  if (!slot) return;

  if (!auth || !db) {
    slot.innerHTML =
      '<a class="btn sm" href="login.html">Login</a>';
    return;
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      slot.innerHTML = `
        <a class="btn sm ghost" href="login.html">Login</a>
        <a class="btn sm gold" href="login.html?tab=register">Register</a>
      `;
      return;
    }

    try {
      const account = await getRole(user);

      if (!account || !HOME[account.role]) {
        slot.innerHTML = `
          <a class="btn sm ghost" href="login.html">Account</a>
        `;
        return;
      }

      slot.innerHTML = `
        <a class="btn sm gold"
           href="${HOME[account.role]}">Dashboard</a>
        <button class="btn sm ghost" id="outBtn" type="button">
          Logout
        </button>
      `;

      $("#outBtn", slot)?.addEventListener("click", logout);
    } catch (error) {
      console.error("Navigation account check failed:", error);

      slot.innerHTML =
        '<a class="btn sm" href="login.html">Login</a>';
    }
  });
}

// Admin audit logging
export async function audit(action, target, detail = "") {
  if (!db || !auth?.currentUser) {
    throw new Error("An authenticated admin session is required.");
  }

  const {
    addDoc,
    collection,
    serverTimestamp
  } = await import(
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
  );

  await addDoc(collection(db, "audit"), {
    adminId: auth.currentUser.uid,
    adminEmail: auth.currentUser.email,
    action,
    target,
    detail,
    at: serverTimestamp()
  });
}
