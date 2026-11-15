
import {
  $,
  toast,
  initTheme,
  initNav,
  showConfigBanner,
  auth,
  db,
  getRole,
  HOME,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendPasswordResetEmail,
  onAuthStateChanged,
  doc,
  writeBatch,
  serverTimestamp
} from "./common.js";

initTheme();
initNav();
showConfigBanner();

const qs = new URLSearchParams(location.search);

let busy = false;

const phoneOk = value => /^[6-9]\d{9}$/.test(value);
const emailOk = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const regOk = value => /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(value);

// Switch between login and registration forms.
function show(tab) {
  const forms = {
    login: $("#fLogin"),
    register: $("#fReg"),
    driver: $("#fDrv")
  };

  Object.entries(forms).forEach(([name, form]) => {
    if (form) form.classList.toggle("on", name === tab);
  });

  document.querySelectorAll(".tab").forEach(button => {
    button.classList.toggle("on", button.dataset.t === tab);
    button.setAttribute(
      "aria-selected",
      String(button.dataset.t === tab)
    );
  });

  const title = $("#ttl");

  if (title) {
    title.textContent = {
      login: "Welcome back",
      register: "Create customer account",
      driver: "Drive with MANA TAXI"
    }[tab] || "Welcome";
  }
}

document.querySelectorAll(".tab").forEach(button => {
  button.addEventListener("click", () => show(button.dataset.t));
});

show(
  qs.get("tab") === "driver"
    ? "driver"
    : qs.get("tab") === "register"
      ? "register"
      : "login"
);

if (qs.get("admin") && $("#adminHint")) {
  $("#adminHint").hidden = false;
}

// Firebase error messages.
function friendly(error) {
  const messages = {
    "auth/invalid-credential": "Wrong email or password.",
    "auth/user-not-found": "No account found with this email.",
    "auth/wrong-password": "Wrong email or password.",
    "auth/email-already-in-use": "This email is already registered.",
    "auth/weak-password": "Password must be at least 8 characters.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/too-many-requests": "Too many attempts. Try again later.",
    "auth/network-request-failed": "Network problem. Check your connection.",
    "permission-denied": "Permission denied. Please contact support."
  };

  return messages[error?.code] ||
    error?.message ||
    "Something went wrong. Please try again.";
}

// Redirect users according to their Firestore role.
async function go(user) {
  const account = await getRole(user);

  if (!account || !HOME[account.role]) {
    toast("Account profile not found. Please contact support.", "error");
    return;
  }

  if (account.profile?.status === "suspended") {
    await auth.signOut();
    toast("Your account is suspended. Contact support.", "error");
    location.replace("login.html");
    return;
  }

  location.replace(HOME[account.role]);
}

// Existing authentication session.
if (auth) {
  onAuthStateChanged(auth, user => {
    if (user && !busy) {
      go(user).catch(error => {
        console.error("Account redirect error:", error);
        toast("Could not load your account.", "error");
      });
    }
  });
}

// Login form.
$("#fLogin")?.addEventListener("submit", async event => {
  event.preventDefault();

  if (!auth || !db) {
    showConfigBanner();
    return;
  }

  if (busy) return;

  const email = $("#lE").value.trim().toLowerCase();
  const password = $("#lP").value;
  const button = $("#lB");

  if (!emailOk(email) || !password) {
    toast("Enter a valid email and password.", "error");
    return;
  }

  busy = true;
  button.disabled = true;

  try {
    const credential = await signInWithEmailAndPassword(
      auth,
      email,
      password
    );

    await go(credential.user);
  } catch (error) {
    console.error("Login error:", error);
    toast(friendly(error), "error");
    busy = false;
  } finally {
    button.disabled = false;
  }
});

// Forgot password.
$("#forgot")?.addEventListener("click", async event => {
  event.preventDefault();

  if (!auth) {
    showConfigBanner();
    return;
  }

  const email = $("#lE").value.trim().toLowerCase();

  if (!emailOk(email)) {
    toast("Enter your email address in the email field first.", "error");
    return;
  }

  try {
    await sendPasswordResetEmail(auth, email);

    toast(
      "If that email exists, a password reset link has been sent.",
      "success"
    );
  } catch (error) {
    console.error("Password reset error:", error);
    toast(friendly(error), "error");
  }
});

// Shared registration for customers and drivers.
async function register(role, form, button) {
  const fail = message => {
    toast(message, "error");
    return false;
  };

  if (!auth || !db) {
    showConfigBanner();
    return false;
  }

  if (busy) return false;

  if (form.name.length < 2) {
    return fail("Enter your full name.");
  }

  if (!emailOk(form.email)) {
    return fail("Enter a valid email address.");
  }

  if (!phoneOk(form.phone)) {
    return fail("Enter a valid 10-digit Indian mobile number.");
  }

  if (form.pw.length < 8) {
    return fail("Password must be at least 8 characters.");
  }

  if (form.pw !== form.pc) {
    return fail("Passwords do not match.");
  }

  if (!form.terms) {
    return fail("Please accept the terms and conditions.");
  }

  if (role === "driver") {
    if (
      !form.lic ||
      !form.licExp ||
      !form.model ||
      !form.reg ||
      !form.rc ||
      !form.ins ||
      !form.vtype
    ) {
      return fail("Fill in all licence and vehicle details.");
    }

    const expiry = new Date(`${form.licExp}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (
      Number.isNaN(expiry.getTime()) ||
      expiry < today
    ) {
      return fail("Enter a valid, unexpired licence date.");
    }

    if (!regOk(form.reg)) {
      return fail(
        "Vehicle registration format looks incorrect. Example: AP31AB1234."
      );
    }
  }

  busy = true;
  const originalText = button.textContent;

  button.disabled = true;
  button.textContent = "Creating account...";

  try {
    const email = form.email.toLowerCase();

    // Create Firebase Authentication account.
    const credential = await createUserWithEmailAndPassword(
      auth,
      email,
      form.pw
    );

    await updateProfile(credential.user, {
      displayName: form.name
    });

    // Store user profile and driver application.
    const batch = writeBatch(db);

    batch.set(doc(db, "users", credential.user.uid), {
      name: form.name,
      email,
      phone: form.phone,
      role,
      status: "active",
      createdAt: serverTimestamp(),
      activeBookingId: null
    });

    if (role === "driver") {
      batch.set(doc(db, "drivers", credential.user.uid), {
        name: form.name,
        email,
        phone: form.phone,

        licenseNo: form.lic,
        licenseExpiry: form.licExp,

        vehicleType: form.vtype,
        vehicleModel: form.model,
        vehicleNo: form.reg,

        rcNo: form.rc,
        insuranceNo: form.ins,

        approval: "PENDING",
        online: false,
        activeBookingId: null,

        lat: null,
        lng: null,

        createdAt: serverTimestamp()
      });
    }

    await batch.commit();

    if (role === "driver") {
      toast(
        "Driver application submitted. Awaiting admin approval.",
        "success"
      );
    } else {
      toast("Customer account created successfully!", "success");
    }

    location.replace(HOME[role] || "index.html");

  } catch (error) {
    console.error("Registration error:", error);

    toast(friendly(error), "error");

    // Do not automatically delete the Firebase Auth account here:
    // the profile write may have failed after account creation.
    // This avoids silently removing an account that may need recovery.

    busy = false;
    button.disabled = false;
    button.textContent = originalText;
  }
}

// Customer registration.
$("#fReg")?.addEventListener("submit", event => {
  event.preventDefault();

  register(
    "customer",
    {
      name: $("#rN").value.trim(),
      email: $("#rE").value.trim(),
      phone: $("#rM").value.trim(),
      pw: $("#rP").value,
      pc: $("#rC").value,
      terms: $("#rT").checked
    },
    $("#rB")
  );
});

// Driver registration.
$("#fDrv")?.addEventListener("submit", event => {
  event.preventDefault();

  register(
    "driver",
    {
      name: $("#dN").value.trim(),
      email: $("#dE").value.trim(),
      phone: $("#dM").value.trim(),
      pw: $("#dP").value,
      pc: $("#dC").value,
      terms: $("#dT2").checked,

      lic: $("#dL").value.trim(),
      licExp: $("#dLE").value,
      vtype: $("#dT").value,
      model: $("#dV").value.trim(),

      reg: $("#dR").value
        .toUpperCase()
        .replace(/[\s-]/g, ""),

      rc: $("#dRC").value.trim(),
      ins: $("#dI").value.trim()
    },
    $("#dB")
  );
});
