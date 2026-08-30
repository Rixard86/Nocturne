import { $ } from './ui.js';

/* ============================================================
   BOOT SCREEN
   Shown by default in the markup, so it paints as soon as the WebView renders —
   module scripts are deferred, so this covers module evaluation, the async
   settings/history reads, and any session recovery that follows.
   ============================================================ */

// Backstop: if startup throws or a recovery hangs, never strand the user behind
// the overlay. Long enough not to interrupt a normal recovery.
const BOOT_FAILSAFE_MS = 8000;

let dismissed = false;
const startedAt = Date.now();

function bootElapsed() {
  return Date.now() - startedAt;
}

function setBootStatus(text) {
  console.log(`[boot ${bootElapsed()}ms] ${text}`);
  const el = $('bootStatus');
  if (el && !dismissed) el.textContent = text;
}

function hideBoot() {
  if (dismissed) return;
  dismissed = true;
  console.log(`[boot ${bootElapsed()}ms] dismissed`);
  const el = $('boot');
  if (!el) return;
  el.classList.add('done');
  // Remove it once the fade finishes so it can never swallow a tap.
  setTimeout(() => el.remove(), 500);
}

function startBootFailsafe() {
  setTimeout(hideBoot, BOOT_FAILSAFE_MS);
}

export { hideBoot, setBootStatus, startBootFailsafe };
