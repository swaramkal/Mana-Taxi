
import {
  initTheme,
  initNav,
  showConfigBanner,
  loadSettings,
  auth,
  toast
} from './common.js';

import { mountBooking } from './booking.js';

// Homepage initialization
async function initHome() {
  const bookingRoot = document.getElementById('bookingRoot');

  // Initialize common website features
  initTheme();
  initNav();
  showConfigBanner();

  if (!bookingRoot) {
    console.error('Booking root element not found.');
    return;
  }

  try {
    // Wait for Firebase authentication initialization
    if (auth?.authStateReady) {
      await auth.authStateReady();
    }

    // Load fare and vehicle settings
    const settings = await loadSettings();

    // Verify Leaflet map library is available
    if (!window.L) {
      throw new Error('Map service could not be loaded. Please refresh the page.');
    }

    // Initialize booking interface
    mountBooking(bookingRoot, {
      settings,

      bookLabel: 'Book a Taxi',

      onBook: (bookingData) => {
        try {
          // Save temporary booking information
          sessionStorage.setItem(
            'mt_draft',
            JSON.stringify(bookingData)
          );

          // Continue to customer dashboard or login
          if (auth?.currentUser) {
            window.location.href = 'customer.html';
          } else {
            window.location.href = 'login.html?next=customer';
          }

        } catch (error) {
          console.error('Booking preparation failed:', error);
          toast(
            'Unable to save booking details. Please try again.',
            'error'
          );
        }
      }
    });

    console.log('MANA TAXI homepage initialized successfully.');

  } catch (error) {
    console.error('Homepage initialization error:', error);

    bookingRoot.innerHTML = `
      <div class="card">
        <h3>Booking temporarily unavailable</h3>
        <p class="muted">
          We could not initialize the booking system.
          Please refresh the page and try again.
        </p>
        <button class="btn gold" id="retryBooking">
          Try Again
        </button>
      </div>
    `;

    document.getElementById('retryBooking')
      ?.addEventListener('click', () => {
        window.location.reload();
      });
  }
}

// Start homepage
initHome();
