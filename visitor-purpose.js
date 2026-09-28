/* ============================================================
   visitor-purpose.js
   Purpose-based access for the Visitor role.

   1. Right after login, a Visitor must choose the purpose of today's visit
      (from Permissions.VISIT_PURPOSES in permissions.js). It is saved on
      the server and resets every day.
   2. The server then only sends the buildings and rooms tied to that
      purpose (plus always-visible places like the gates and clinic) — see
      getCallerScope() in server.js. This file applies the same rules in
      the browser as a second layer, so the map, search, building panel,
      multi-stop and AI chat only ever show those places.
   3. A small card at the top of the sidebar shows the current purpose,
      with a "Change" button.
   4. Every navigation is logged for the Admin's Visitor Purpose Log, and
      marked "Arrived" when the visitor's GPS reaches the destination.
   5. After arriving, the visitor is asked "Are you done?". "Yes, I'm done"
      marks the visit Completed, ends purpose-based access (only the gates,
      clinic and canteens remain) and gives directions to the nearest exit.
      Reaching an exit gate afterwards marks the visit Checked Out.

   Public API (used by script.js):
     await window.VisitPurpose.ensureDailyPurpose()  -> false if the visitor logged out instead
     window.VisitPurpose.applyScope()                -> trims campusData to the visitor's places
     await window.ensureVisitPurpose(destination)    -> true to continue navigating
     window.VisitPurpose.clear()                     -> reset on logout

   Other roles are never affected (the `requireVisitPurpose` feature flag).
   Load after script.js:  <script src="visitor-purpose.js" defer></script>
   ============================================================ */
(function () {
    'use strict';

    const ARRIVAL_RADIUS_M = 30;
    const GATE_RADIUS_M = 40;
    const DONE_PROMPT_DELAY_MS = 60 * 1000;      // ask "Are you done?" 1 minute after arriving
    const DONE_REASK_MS = 5 * 60 * 1000;         // "Not yet" → ask again after 5 minutes
    const POSITION_POLL_MS = 5000;

    let current = null;          // { purpose, label, places, details } for today
    let finished = false;        // visitor tapped "Yes, I'm done" today
    let checkedOut = false;      // visitor reached an exit gate after the visit
    let scopeApplied = false;    // campusData has been trimmed for this visitor
    const logged = new Map();    // destination key -> { visitId, name, coords, arrived, arrivedPending, promptDone }
    let donePromptTimer = null;
    let expiresAt = null;        // Date — Visitor accounts end at 5:00 PM (VISITOR_ACCESS_HOURS)
    let expiryTimers = [];
    const EXPIRY_WARNING_MS = 15 * 60 * 1000;    // warn 15 minutes before closing time
    const HOURS_CHECK_MS = 30 * 1000;            // re-check the time (covers phones waking from sleep)

    // ── Helpers ────────────────────────────────────────────────
    function getSession() {
        return (typeof getAuthSession === 'function') ? getAuthSession() : null;
    }

    function isScopedVisitor(session = getSession()) {
        if (!session?.userId) return false;
        if (typeof window.Permissions?.canUseFeature === 'function') {
            return window.Permissions.canUseFeature(session.role, 'requireVisitPurpose');
        }
        return String(session.role || '').toUpperCase() === 'VISITOR';
    }

    function getPurposes() {
        return Array.isArray(window.Permissions?.VISIT_PURPOSES) ? window.Permissions.VISIT_PURPOSES : [];
    }

    function getCampus() {
        if (typeof campusData === 'undefined') return null;
        const key = (typeof state !== 'undefined' && state.currentCampus) || 'iba';
        return campusData[key] || null;
    }

    function notify(message, type = 'info') {
        if (typeof showNotification === 'function') showNotification(message, type);
    }

    function escapeHtml(str) {
        const d = document.createElement('div');
        d.textContent = str ?? '';
        return d.innerHTML;
    }

    function distanceMeters(lat1, lng1, lat2, lng2) {
        const R = 6371000;
        const toRad = d => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function destinationCoords(dest) {
        const c = dest.coords || dest.coordinates;
        if (Array.isArray(c) && c.length >= 2 && isFinite(c[0]) && isFinite(c[1])) {
            return [Number(c[0]), Number(c[1])];
        }
        if (isFinite(dest.lat) && isFinite(dest.lng)) return [Number(dest.lat), Number(dest.lng)];
        return null;
    }

    function describeDestination(dest) {
        const isRoom = dest.matchType === 'room' || !!dest.buildingName;
        return {
            name: dest.name || dest.displayName || 'Selected location',
            type: isRoom ? 'room' : 'building',
            building: isRoom ? (dest.buildingName || null) : null
        };
    }

    function destinationKey(dest) {
        let id = dest.id;
        try {
            if (typeof msNormalizeLocation === 'function') id = msNormalizeLocation(dest).id;
        } catch { /* fall back to raw id */ }
        return String(id ?? dest.name);
    }

    // Is this destination one of the visitor's allowed places?
    function isDestinationAllowed(dest) {
        const P = window.Permissions;
        if (!P?.canVisitorSeeBuilding) return true;
        const purpose = current?.purpose || null;
        const info = describeDestination(dest);
        const campus = getCampus();

        if (info.type === 'room') {
            const building = campus?.locations.find(l => l.name === info.building || l.shortName === info.building)
                || { name: info.building };
            return P.canVisitorSeeRoom(purpose, building, info.name);
        }
        const building = campus?.locations.find(l => l.id === dest.id || l.name === dest.name) || dest;
        return P.canVisitorSeeBuilding(purpose, building);
    }

    // ── Let scoped data through the old building-type check ────
    // Visitors used to be limited by building type. Their data is now
    // limited by purpose instead (server + applyScope below), so once the
    // scope is applied the type check must not hide, for example, a
    // college's Dean's Office that their purpose allows.
    (function wrapTypeCheck() {
        const P = window.Permissions;
        if (!P || P._visitPurposeWrapped) return;
        const original = P.canAccessLocationType;
        P.canAccessLocationType = function (role, type) {
            if (scopeApplied && isScopedVisitor()) return true;
            return original.call(this, role, type);
        };
        P._visitPurposeWrapped = true;
    })();

    // ── Styles ─────────────────────────────────────────────────
    const style = document.createElement('style');
    style.id = 'visitor-purpose-styles';
    style.textContent = `
        #vp-overlay {
            position: fixed;
            inset: 0;
            z-index: 10050; /* above the loading screen and Add Stop modal */
            display: none;
            align-items: center;
            justify-content: center;
            padding: 16px;
            background: rgba(15, 47, 74, 0.55);
            -webkit-backdrop-filter: blur(4px);
            backdrop-filter: blur(4px);
        }
        #vp-overlay.active { display: flex; }
        #vp-modal {
            width: min(440px, 100%);
            max-height: calc(100dvh - 32px);
            overflow-y: auto;
            background: #ffffff;
            border-radius: 20px;
            padding: 22px 20px 18px;
            box-shadow: 0 24px 48px -16px rgba(15, 47, 74, 0.35);
            font-family: "Sora", "Segoe UI", sans-serif;
            animation: vpIn 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        @keyframes vpIn {
            from { opacity: 0; transform: translateY(10px) scale(0.98); }
            to   { opacity: 1; transform: none; }
        }
        #vp-modal .vp-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
        #vp-modal .vp-icon {
            width: 42px; height: 42px; flex-shrink: 0; border-radius: 12px;
            display: grid; place-items: center; background: #fef3c7; color: #b45309;
        }
        #vp-modal h3 { margin: 0 0 3px; font-size: 17px; font-weight: 800; color: #0f2f4a; }
        #vp-modal .vp-sub { margin: 0; font-size: 12.5px; line-height: 1.45; color: #5b6b7e; }
        #vp-modal label { display: block; margin: 0 0 6px; font-size: 12.5px; font-weight: 600; color: #334155; }
        #vp-modal label .vp-tag { font-weight: 500; color: #8a99ab; }
        #vp-modal select, #vp-modal textarea {
            width: 100%; box-sizing: border-box;
            border: 1.5px solid #dbe3ec; border-radius: 12px;
            background-color: #f7f9fc; color: #1e293b;
            font-family: inherit; font-size: 14px;
            transition: border-color 0.2s, box-shadow 0.2s, background-color 0.2s;
        }
        #vp-modal select {
            height: 48px; padding: 0 42px 0 14px;
            -webkit-appearance: none; appearance: none; cursor: pointer;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%235b6b7e' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
            background-repeat: no-repeat; background-position: right 14px center; background-size: 16px;
        }
        #vp-modal textarea { min-height: 70px; padding: 10px 14px; resize: vertical; }
        #vp-modal select:focus, #vp-modal textarea:focus {
            outline: none; border-color: #1f8a9e; background-color: #ffffff;
            box-shadow: 0 0 0 4px rgba(31, 138, 158, 0.15);
        }
        #vp-modal .vp-places {
            display: none; gap: 8px; align-items: flex-start;
            margin: 10px 0 14px; padding: 10px 12px; border-radius: 12px;
            background: #f0f7fa; border: 1px solid #d6e9f0;
            font-size: 12.5px; line-height: 1.45; color: #0f2f4a;
        }
        #vp-modal .vp-places.show { display: flex; }
        #vp-modal .vp-places small { display: block; margin-top: 3px; color: #5b6b7e; font-size: 11.5px; }
        #vp-modal .vp-spacer { height: 14px; }
        #vp-modal .vp-count { margin-top: 4px; text-align: right; font-size: 11px; color: #8a99ab; }
        #vp-modal .vp-error { min-height: 18px; margin: 6px 0 0; font-size: 12px; font-weight: 600; color: #dc2626; }
        #vp-modal .vp-actions { display: flex; gap: 10px; margin-top: 10px; }
        #vp-modal .vp-actions button {
            flex: 1; height: 46px; border-radius: 12px;
            font-family: inherit; font-size: 14px; font-weight: 700; cursor: pointer;
            transition: transform 0.15s ease, box-shadow 0.2s ease, background-color 0.2s ease;
        }
        #vp-secondary { border: 1.5px solid #dbe3ec; background: #ffffff; color: #5b6b7e; }
        #vp-secondary:hover { background: #f5f7fa; }
        #vp-continue {
            border: none; color: #ffffff;
            background: linear-gradient(135deg, #0f2f4a 0%, #1e5b7a 55%, #1f8a9e 100%);
            box-shadow: 0 8px 18px -6px rgba(15, 58, 82, 0.45);
        }
        #vp-continue:hover { transform: translateY(-1px); }
        #vp-continue:active { transform: scale(0.985); }
        #vp-continue:disabled { opacity: 0.6; cursor: wait; transform: none; }
        #vp-modal .vp-actions button:focus-visible { outline: none; box-shadow: 0 0 0 4px rgba(31, 138, 158, 0.3); }

        /* Sidebar card showing the current purpose */
        #vpChip {
            display: flex; align-items: flex-start; gap: 10px;
            margin-bottom: 14px; padding: 12px 14px;
            border-radius: 10px; border-left: 5px solid #f0a500;
            background: linear-gradient(135deg, #fff8e1 0%, #fffdf6 100%);
            font-family: "Sora", "Segoe UI", sans-serif;
            flex-shrink: 0;
        }
        #vpChip .vp-chip-icon { font-size: 20px; line-height: 1.2; }
        #vpChip .vp-chip-body { flex: 1; min-width: 0; }
        #vpChip .vp-chip-label { font-size: 10.5px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; color: #92400e; }
        #vpChip .vp-chip-purpose { font-size: 13.5px; font-weight: 700; color: #3b2a05; margin-top: 1px; }
        #vpChip .vp-chip-places { font-size: 11.5px; color: #6b5a2e; margin-top: 3px; line-height: 1.4; }
        #vpChip button {
            flex-shrink: 0; border: 1px solid rgba(146, 64, 14, 0.3); background: rgba(255, 255, 255, 0.7);
            color: #92400e; font-family: inherit; font-size: 12px; font-weight: 700;
            padding: 6px 10px; border-radius: 8px; cursor: pointer;
        }
        #vpChip button:hover { background: #ffffff; }
        #vpChip .vp-chip-expiry { font-size: 11px; font-weight: 700; color: #92400e; margin-top: 5px; }
        #vpChip.vp-chip-finished .vp-chip-expiry { color: #15803d; }
        #vpChip .vp-chip-actions { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
        #vpChip button.vp-chip-primary { background: #92400e; color: #ffffff; border-color: #92400e; }
        #vpChip button.vp-chip-primary:hover { background: #7c350c; }
        #vpChip.vp-chip-finished { border-left-color: #16a34a; background: linear-gradient(135deg, #ecfdf3 0%, #f8fffb 100%); }
        #vpChip.vp-chip-finished .vp-chip-label { color: #15803d; }
        #vpChip.vp-chip-finished .vp-chip-purpose { color: #0f3d24; }
        #vpChip.vp-chip-finished .vp-chip-places { color: #3f6b52; }
        #vpChip.vp-chip-finished button { color: #15803d; border-color: rgba(21, 128, 61, 0.35); }
        #vpChip.vp-chip-finished button.vp-chip-primary { background: #16a34a; border-color: #16a34a; color: #ffffff; }

        /* "Are you done?" dialog after arriving */
        #vp-done-overlay {
            position: fixed; inset: 0; z-index: 10040;
            display: none; align-items: center; justify-content: center; padding: 16px;
            background: rgba(15, 47, 74, 0.45);
            -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
        }
        #vp-done-overlay.active { display: flex; }
        #vp-done-modal {
            width: min(400px, 100%); background: #ffffff; border-radius: 20px;
            padding: 24px 20px 18px; text-align: center;
            box-shadow: 0 24px 48px -16px rgba(15, 47, 74, 0.35);
            font-family: "Sora", "Segoe UI", sans-serif;
            animation: vpIn 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        #vp-done-modal .vp-done-icon {
            width: 52px; height: 52px; margin: 0 auto 12px; border-radius: 50%;
            display: grid; place-items: center; font-size: 26px; background: #dcfce7;
        }
        #vp-done-modal h3 { margin: 0 0 6px; font-size: 17px; font-weight: 800; color: #0f2f4a; }
        #vp-done-modal p { margin: 0 0 16px; font-size: 13px; line-height: 1.5; color: #5b6b7e; }
        #vp-done-modal .vp-done-actions { display: flex; flex-direction: column; gap: 8px; }
        #vp-done-modal button {
            height: 46px; border-radius: 12px; font-family: inherit; font-size: 14px; font-weight: 700; cursor: pointer;
            border: 1.5px solid #dbe3ec; background: #ffffff; color: #334155;
        }
        #vp-done-modal button:hover { background: #f5f7fa; }
        #vp-done-yes {
            border: none !important; color: #ffffff !important;
            background: linear-gradient(135deg, #15803d 0%, #16a34a 100%) !important;
            box-shadow: 0 8px 18px -6px rgba(22, 163, 74, 0.45);
        }
        #vp-done-yes:disabled { opacity: 0.6; cursor: wait; }
        #vp-done-modal .vp-error { min-height: 16px; margin: 8px 0 0; font-size: 12px; font-weight: 600; color: #dc2626; }
        @media (prefers-reduced-motion: reduce) { #vp-modal { animation: none; } }
    `;
    document.head.appendChild(style);

    // ── Modal markup ───────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.id = 'vp-overlay';
    overlay.innerHTML = `
        <div id="vp-modal" role="dialog" aria-modal="true" aria-labelledby="vp-title">
            <div class="vp-head">
                <div class="vp-icon" aria-hidden="true">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6a2 2 0 0 1 2 2v1H7V5a2 2 0 0 1 2-2z"/><rect x="4" y="6" width="16" height="15" rx="2"/><path d="M8 11h8M8 15h5"/></svg>
                </div>
                <div>
                    <h3 id="vp-title">Purpose of Your Visit</h3>
                    <p class="vp-sub" id="vpSub">Please tell us why you're visiting today. The map will show only the offices related to your purpose.</p>
                </div>
            </div>

            <label for="vpPurpose">Purpose</label>
            <select id="vpPurpose"></select>

            <div class="vp-places" id="vpPlaces" aria-live="polite">
                <span aria-hidden="true">📍</span>
                <div>
                    <strong>You can navigate to:</strong> <span id="vpPlacesText"></span>
                    <small>The gates, clinic, cafeteria and canteen are always available.</small>
                </div>
            </div>
            <div class="vp-spacer" id="vpSpacer"></div>

            <label for="vpDetails">Details <span class="vp-tag" id="vpDetailsTag">(optional)</span></label>
            <textarea id="vpDetails" maxlength="200" placeholder="e.g. Transcript of records for my son"></textarea>
            <div class="vp-count"><span id="vpCount">0</span>/200</div>

            <p class="vp-error" id="vpError" role="alert"></p>

            <div class="vp-actions">
                <button type="button" id="vp-secondary">Log out</button>
                <button type="button" id="vp-continue">Continue</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const doneOverlay = document.createElement('div');
    doneOverlay.id = 'vp-done-overlay';
    doneOverlay.innerHTML = `
        <div id="vp-done-modal" role="dialog" aria-modal="true" aria-labelledby="vp-done-title">
            <div class="vp-done-icon" aria-hidden="true">✅</div>
            <h3 id="vp-done-title">You've arrived</h3>
            <p id="vpDoneText"></p>
            <div class="vp-done-actions">
                <button type="button" id="vp-done-yes">Yes, I'm done</button>
                <button type="button" id="vp-done-another">I need another office</button>
                <button type="button" id="vp-done-later">Not yet</button>
            </div>
            <p class="vp-error" id="vpDoneError" role="alert"></p>
        </div>
    `;
    document.body.appendChild(doneOverlay);

    const els = {
        sub: overlay.querySelector('#vpSub'),
        select: overlay.querySelector('#vpPurpose'),
        places: overlay.querySelector('#vpPlaces'),
        placesText: overlay.querySelector('#vpPlacesText'),
        spacer: overlay.querySelector('#vpSpacer'),
        details: overlay.querySelector('#vpDetails'),
        detailsTag: overlay.querySelector('#vpDetailsTag'),
        count: overlay.querySelector('#vpCount'),
        error: overlay.querySelector('#vpError'),
        secondary: overlay.querySelector('#vp-secondary'),
        cont: overlay.querySelector('#vp-continue')
    };

    let modal = null; // { mode: 'required'|'change', resolve }

    function selectedPurpose() {
        return getPurposes().find(p => p.value === els.select.value) || null;
    }

    function refreshModalForSelection() {
        const p = selectedPurpose();
        const required = !!p?.requiresDetails;
        els.detailsTag.textContent = required ? '(required)' : '(optional)';
        els.details.placeholder = required
            ? 'Please describe the purpose of your visit'
            : 'e.g. Transcript of records for my son';
        els.placesText.textContent = p?.places || '';
        els.places.classList.toggle('show', !!p);
        els.spacer.style.display = p ? 'none' : '';
        els.error.textContent = '';
    }

    function closeModal(result) {
        overlay.classList.remove('active');
        document.removeEventListener('keydown', onKeydown, true);
        const m = modal;
        modal = null;
        if (m) m.resolve(result);
    }

    function onKeydown(e) {
        if (e.key === 'Escape' && modal?.mode === 'change') {
            e.stopPropagation();
            closeModal(null);
        }
    }

    async function submitModal() {
        const p = selectedPurpose();
        const details = els.details.value.trim();
        if (!p) {
            els.error.textContent = 'Please select the purpose of your visit.';
            els.select.focus();
            return;
        }
        if (p.requiresDetails && !details) {
            els.error.textContent = 'Please describe the purpose of your visit.';
            els.details.focus();
            return;
        }

        const session = getSession();
        els.cont.disabled = true;
        els.cont.textContent = 'Saving…';
        try {
            const res = await fetch('/api/visitor/purpose', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: session?.userId, purpose: p.value, details: details || null })
            });
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error || 'Could not save your purpose. Please try again.');
            closeModal({ purpose: data.purpose, label: data.label, places: data.places, details: data.details });
        } catch (err) {
            els.error.textContent = err.message || 'Could not save your purpose. Please check your connection.';
        } finally {
            els.cont.disabled = false;
            els.cont.textContent = modal?.mode === 'change' ? 'Save' : 'Continue';
        }
    }

    els.select.addEventListener('change', refreshModalForSelection);
    els.details.addEventListener('input', () => {
        els.count.textContent = String(els.details.value.length);
        els.error.textContent = '';
    });
    els.cont.addEventListener('click', submitModal);
    els.secondary.addEventListener('click', () => closeModal(modal?.mode === 'required' ? 'logout' : null));

    // mode 'required': first time today (Log out / Continue, cannot be dismissed)
    // mode 'change'  : from the sidebar card (Cancel / Save)
    function openModal(mode) {
        if (modal) closeModal(null);

        els.select.innerHTML =
            `<option value="" disabled selected>Select a purpose</option>` +
            getPurposes().map(p => `<option value="${escapeHtml(p.value)}">${escapeHtml(p.label)}</option>`).join('');

        if (mode === 'change' && current) {
            els.select.value = current.purpose;
            els.details.value = current.details || '';
        } else {
            els.details.value = '';
        }
        els.count.textContent = String(els.details.value.length);
        refreshModalForSelection();

        els.sub.textContent = mode === 'change'
            ? 'Changing your purpose updates which offices you can see and navigate to.'
            : "Please tell us why you're visiting today. The map will show only the offices related to your purpose.";
        els.secondary.textContent = mode === 'change' ? 'Cancel' : 'Log out';
        els.cont.textContent = mode === 'change' ? 'Save' : 'Continue';

        overlay.classList.add('active');
        document.addEventListener('keydown', onKeydown, true);
        setTimeout(() => els.select.focus(), 50);

        return new Promise(resolve => { modal = { mode, resolve }; });
    }

    // ── Sidebar card ───────────────────────────────────────────
    function renderChip() {
        let chip = document.getElementById('vpChip');
        if ((!current && !finished) || !isScopedVisitor()) {
            chip?.remove();
            return;
        }
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;
        if (!chip) {
            chip = document.createElement('div');
            chip.id = 'vpChip';
            sidebar.insertBefore(chip, sidebar.firstChild);
        }

        if (finished) {
            chip.className = 'vp-chip-finished';
            chip.innerHTML = `
                <div class="vp-chip-icon" aria-hidden="true">${checkedOut ? '👋' : '✅'}</div>
                <div class="vp-chip-body">
                    <div class="vp-chip-label">${checkedOut ? 'Checked out' : 'Visit completed'}</div>
                    <div class="vp-chip-purpose">${checkedOut ? 'Thank you for visiting PRMSU!' : 'Please proceed to the exit'}</div>
                    <div class="vp-chip-places">Only the gates, clinic, cafeteria and canteen are shown now. Need something else? Choose a new purpose.</div>
                    ${expiresAt ? `<div class="vp-chip-expiry">🕖 Access until ${escapeHtml(formatClock(expiresAt))}</div>` : ''}
                </div>
                <div class="vp-chip-actions">
                    ${checkedOut ? '' : '<button type="button" class="vp-chip-primary" id="vpChipExit">🧭 Go to Exit</button>'}
                    <button type="button" id="vpChipNew">New purpose</button>
                </div>
            `;
            chip.querySelector('#vpChipExit')?.addEventListener('click', directionsToExit);
            chip.querySelector('#vpChipNew').addEventListener('click', changePurpose);
            return;
        }

        chip.className = '';
        chip.innerHTML = `
            <div class="vp-chip-icon" aria-hidden="true">🧾</div>
            <div class="vp-chip-body">
                <div class="vp-chip-label">Purpose of visit</div>
                <div class="vp-chip-purpose">${escapeHtml(current.label)}</div>
                <div class="vp-chip-places">${escapeHtml(current.places || '')}</div>
                ${expiresAt ? `<div class="vp-chip-expiry">🕖 Access until ${escapeHtml(formatClock(expiresAt))}</div>` : ''}
            </div>
            <div class="vp-chip-actions">
                <button type="button" class="vp-chip-primary" id="vpChipDone">I'm done</button>
                <button type="button" id="vpChipChange">Change</button>
            </div>
        `;
        chip.querySelector('#vpChipDone').addEventListener('click', () => openDonePrompt(null));
        chip.querySelector('#vpChipChange').addEventListener('click', changePurpose);
    }

    // ── Daily purpose (called by script.js right after login) ──
    async function ensureDailyPurpose() {
        const session = getSession();
        if (!isScopedVisitor(session)) {
            current = null;
            renderChip();
            return true;
        }

        if (!current && !finished) {
            try {
                const res = await fetch(`/api/visitor/purpose?userId=${encodeURIComponent(session.userId)}`);
                const data = await res.json();
                if (data.ok && data.expired) {
                    endExpiredSession();
                    return false;
                }
                if (data.ok) scheduleExpiry(data.expiresAt);
                if (data.ok && data.purpose) {
                    current = { purpose: data.purpose, label: data.label, places: data.places, details: data.details };
                } else if (data.ok && data.finished) {
                    finished = true; // already completed today — exit-only map
                }
            } catch (err) {
                console.warn('Could not load visit purpose:', err);
            }
        }

        if (!current && !finished) {
            const result = await openModal('required');
            if (result === 'logout' || !result) {
                if (typeof window.logoutUser === 'function') window.logoutUser();
                return false;
            }
            current = result;
        }

        renderChip();
        return true;
    }

    // ── Visitor accounts: 7:00 AM – 5:00 PM only ───────────────
    function accessHours() {
        return window.Permissions?.VISITOR_ACCESS_HOURS || { start: 7, end: 17 };
    }

    function hourLabel(h) {
        const suffix = h >= 12 ? 'PM' : 'AM';
        return `${h % 12 || 12}:00 ${suffix}`;
    }

    function hoursText() {
        const { start, end } = accessHours();
        return `${hourLabel(start)} to ${hourLabel(end)}`;
    }

    function formatClock(date) {
        return date.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
    }

    // Current hour in the Philippines (e.g. 14.5 = 2:30 PM), whatever the
    // phone's own time zone is set to.
    function manilaHourNow() {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Manila', hour: 'numeric', minute: 'numeric', hourCycle: 'h23'
        }).formatToParts(new Date());
        return Number(parts.find(p => p.type === 'hour').value) + Number(parts.find(p => p.type === 'minute').value) / 60;
    }

    // Today's closing time (5:00 PM Manila). Manila is always UTC+8.
    function todayClosingTime() {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(new Date());
        const get = t => Number(parts.find(p => p.type === t).value);
        return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), accessHours().end - 8, 0, 0));
    }

    function isWithinAccessHours() {
        const { start, end } = accessHours();
        const h = manilaHourNow();
        return h >= start && h < end;
    }

    function scheduleExpiry(value) {
        expiryTimers.forEach(clearTimeout);
        expiryTimers = [];
        expiresAt = value ? new Date(value) : todayClosingTime();
        if (isNaN(expiresAt)) expiresAt = todayClosingTime();

        const msLeft = expiresAt.getTime() - Date.now();
        if (msLeft <= 0) { endExpiredSession(); return; }

        if (msLeft > EXPIRY_WARNING_MS) {
            expiryTimers.push(setTimeout(() => {
                notify(`Visitor access ends at ${formatClock(expiresAt)}. Please finish your transaction and proceed to the exit.`, 'info');
            }, msLeft - EXPIRY_WARNING_MS));
        }
        expiryTimers.push(setTimeout(endExpiredSession, msLeft));
    }

    // Called at 5:00 PM (or when the server says the account has expired).
    function endExpiredSession() {
        if (typeof window.logoutUser === 'function') window.logoutUser();
        clear();
        notify(`Your visitor account has expired. Visitor accounts are valid only from ${hoursText()}, on the day of your visit.`, 'error');
    }

    // Safety net: timers can be delayed while a phone sleeps, so also check
    // the clock regularly while a visitor is logged in.
    setInterval(() => {
        if (!isScopedVisitor()) return;
        if (!isWithinAccessHours() || (expiresAt && Date.now() >= expiresAt.getTime())) endExpiredSession();
    }, HOURS_CHECK_MS);

    // ── Trim campusData to the visitor's places ────────────────
    // The server already sends only these places; this also covers the
    // built-in campus-data.js copy (used before/without a DB sync).
    function applyScope() {
        const session = getSession();
        if (!isScopedVisitor(session)) {
            scopeApplied = false;
            return;
        }
        const campus = getCampus();
        if (campus && typeof window.Permissions?.filterLocationsForPurpose === 'function') {
            campus.locations = window.Permissions.filterLocationsForPurpose(campus.locations, current?.purpose || null);
        }
        scopeApplied = true;
    }

    async function changePurpose() {
        const result = await openModal('change');
        if (!result) return;

        const changed = finished || result.purpose !== current?.purpose;
        current = result;
        finished = false;
        checkedOut = false;
        renderChip();
        if (!changed) return;

        // New purpose → different places. Stop any route to a place that may
        // no longer be allowed, then reload the map from the server.
        logged.clear();
        if (typeof state !== 'undefined' && state.currentRoute && typeof clearRouteCompletely === 'function') {
            clearRouteCompletely();
        }
        if (typeof resyncMapWithDatabase === 'function') {
            await resyncMapWithDatabase();
        } else {
            applyScope();
        }
        if (typeof populateBuildingPanel === 'function') populateBuildingPanel();
        notify(`Purpose updated: ${current.label}`, 'success');
    }

    // ── Per-destination check + log (called before navigating) ─
    function reportArrival(entry) {
        const session = getSession();
        if (!entry.visitId || !session?.userId) return;
        fetch(`/api/visits/${encodeURIComponent(entry.visitId)}/arrived`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: session.userId })
        }).catch(err => console.warn('Could not record visit arrival:', err));
    }

    function exitGates() {
        const names = (window.Permissions?.VISITOR_EXIT_GATES || ['Front Gate', 'Rear Gate']).map(n => n.toLowerCase());
        return (getCampus()?.locations || []).filter(l =>
            names.includes(String(l.shortName || '').toLowerCase()) && destinationCoords(l)
        );
    }

    function reportCheckout(gate) {
        const session = getSession();
        if (!session?.userId) return;
        checkedOut = true;
        fetch('/api/visitor/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: session.userId, gate: gate.name })
        }).catch(err => console.warn('Could not record check-out:', err));

        if (!finished) {
            // Leaving without tapping "I'm done" still ends today's visit.
            finished = true;
            current = null;
            closeDonePrompt();
            if (typeof resyncMapWithDatabase === 'function') resyncMapWithDatabase();
        }
        renderChip();
        notify(`Checked out at ${gate.name}. Thank you for visiting PRMSU!`, 'success');
    }

    // Runs on every live position (navigation feed + periodic GPS check).
    function checkPosition(lat, lng) {
        if (!isScopedVisitor()) return;

        logged.forEach(entry => {
            if (entry.arrived || !entry.coords) return;
            if (distanceMeters(lat, lng, entry.coords[0], entry.coords[1]) > ARRIVAL_RADIUS_M) return;
            entry.arrived = true;
            if (entry.visitId) reportArrival(entry);
            else entry.arrivedPending = true; // report once the visit has an id
            scheduleDonePrompt(entry, DONE_PROMPT_DELAY_MS);
        });

        // Check out at a gate — only after the visit, never on the way in.
        const visitedSomewhere = [...logged.values()].some(e => e.arrived);
        if (!checkedOut && (finished || visitedSomewhere)) {
            const gate = exitGates().find(g => {
                const c = destinationCoords(g);
                return distanceMeters(lat, lng, c[0], c[1]) <= GATE_RADIUS_M;
            });
            if (gate) reportCheckout(gate);
        }
    }

    document.addEventListener('navLocationUpdate', (e) => {
        const { lat, lng } = e.detail || {};
        if (typeof lat === 'number' && typeof lng === 'number') checkPosition(lat, lng);
    });

    // Also check whenever the app has a GPS fix outside active navigation
    // (e.g. after "Find My Location"), so arrival/check-out isn't missed.
    setInterval(() => {
        const loc = (typeof state !== 'undefined') ? state.userLocation : null;
        if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') checkPosition(loc.lat, loc.lng);
    }, POSITION_POLL_MS);

    // ── "Are you done?" after arriving ─────────────────────────
    const doneEls = {
        text: doneOverlay.querySelector('#vpDoneText'),
        title: doneOverlay.querySelector('#vp-done-title'),
        yes: doneOverlay.querySelector('#vp-done-yes'),
        another: doneOverlay.querySelector('#vp-done-another'),
        later: doneOverlay.querySelector('#vp-done-later'),
        error: doneOverlay.querySelector('#vpDoneError')
    };
    let donePromptEntry = null;
    let doneMode = 'finish';   // 'finish' | 'reactivate'
    let reactivateCreds = null;

    function scheduleDonePrompt(entry, delay) {
        if (entry.promptDone || finished) return;
        clearTimeout(donePromptTimer);
        donePromptTimer = setTimeout(() => {
            if (!finished && !entry.promptDone) openDonePrompt(entry);
        }, delay);
    }

    function openDonePrompt(entry) {
        if (finished || modal) return;
        doneMode = 'finish';
        doneOverlay.querySelector('.vp-done-icon').textContent = '✅';
        doneEls.yes.style.display = '';
        doneEls.yes.textContent = "Yes, I'm done";
        donePromptEntry = entry;
        doneEls.title.textContent = entry ? "You've arrived" : 'Finish your visit?';
        doneEls.text.textContent = entry
            ? `Are you done with your transaction at ${entry.name}? If you're done, we'll guide you to the nearest exit gate.`
            : "If you're done, your visit will be marked complete and we'll guide you to the nearest exit gate.";
        doneEls.later.textContent = entry ? 'Not yet' : 'Cancel';
        doneEls.another.style.display = entry ? '' : 'none';
        doneEls.error.textContent = '';
        doneOverlay.classList.add('active');
    }

    function closeDonePrompt() {
        doneOverlay.classList.remove('active');
        donePromptEntry = null;
        reactivateCreds = null;
    }

    // Shown by script.js when an expired Visitor tries to log in.
    function offerReactivation({ identifier, password, message, canRequest }) {
        doneMode = 'reactivate';
        reactivateCreds = { identifier, password };
        doneOverlay.querySelector('.vp-done-icon').textContent = '⏰';
        doneEls.title.textContent = 'Visitor access expired';
        doneEls.text.textContent = canRequest
            ? `${message} Visitor accounts are valid only from ${hoursText()} on the day of the visit. An admin will review your request.`
            : message;
        doneEls.yes.textContent = 'Request access for today';
        doneEls.yes.style.display = canRequest ? '' : 'none';
        doneEls.another.style.display = 'none';
        doneEls.later.textContent = 'Close';
        doneEls.error.textContent = '';
        doneOverlay.classList.add('active');
    }

    async function requestReactivation() {
        if (!reactivateCreds) return;
        doneEls.yes.disabled = true;
        doneEls.yes.textContent = 'Sending…';
        try {
            const res = await fetch('/api/auth/visitor/reactivate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(reactivateCreds)
            });
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error || 'Could not send your request.');
            closeDonePrompt();
            notify(data.message || 'Request sent. You can log in once an admin approves it.', 'success');
        } catch (err) {
            doneEls.error.textContent = err.message || 'Could not send your request. Please check your connection.';
        } finally {
            doneEls.yes.disabled = false;
            doneEls.yes.textContent = 'Request access for today';
        }
    }

    doneEls.later.addEventListener('click', () => {
        const entry = donePromptEntry;
        closeDonePrompt();
        if (entry) scheduleDonePrompt(entry, DONE_REASK_MS);
    });

    doneEls.another.addEventListener('click', () => {
        if (donePromptEntry) donePromptEntry.promptDone = true;
        closeDonePrompt();
        notify('Choose your next office from the map or search. Tap "I\'m done" in the sidebar when you finish.', 'info');
    });

    doneEls.yes.addEventListener('click', () => (doneMode === 'reactivate' ? requestReactivation() : finishVisit()));

    async function finishVisit() {
        const session = getSession();
        doneEls.yes.disabled = true;
        doneEls.yes.textContent = 'Saving…';
        try {
            const res = await fetch('/api/visitor/finish', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: session?.userId })
            });
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error || 'Could not finish your visit.');
        } catch (err) {
            doneEls.error.textContent = err.message || 'Could not finish your visit. Please check your connection.';
            return;
        } finally {
            doneEls.yes.disabled = false;
            doneEls.yes.textContent = "Yes, I'm done";
        }

        closeDonePrompt();
        clearTimeout(donePromptTimer);
        logged.forEach(e => { e.promptDone = true; });
        finished = true;
        current = null;

        // Access now shrinks to the always-visible places.
        if (typeof state !== 'undefined' && state.currentRoute && typeof clearRouteCompletely === 'function') {
            clearRouteCompletely();
        }
        if (typeof resyncMapWithDatabase === 'function') {
            await resyncMapWithDatabase();
        } else {
            applyScope();
        }
        if (typeof populateBuildingPanel === 'function') populateBuildingPanel();
        renderChip();
        notify('Thank you! Your visit is marked complete. Guiding you to the nearest exit.', 'success');
        directionsToExit();
    }

    function directionsToExit() {
        const gates = exitGates();
        if (!gates.length) {
            notify('Please proceed to the nearest campus gate.', 'info');
            return;
        }
        const loc = (typeof state !== 'undefined') ? state.userLocation : null;
        let gate = gates[0];
        if (loc && typeof loc.lat === 'number') {
            gate = gates.reduce((best, g) => {
                const c = destinationCoords(g), b = destinationCoords(best);
                return distanceMeters(loc.lat, loc.lng, c[0], c[1]) < distanceMeters(loc.lat, loc.lng, b[0], b[1]) ? g : best;
            }, gates[0]);
        }
        if (typeof window.navigateToLocation === 'function') window.navigateToLocation(gate.id);
    }

    async function ensureVisitPurpose(dest) {
        if (!dest) return false;
        const session = getSession();
        if (!isScopedVisitor(session)) return true;   // Students/Employees/Admin

        if (!current && !finished) {
            const ok = await ensureDailyPurpose();
            if (!ok) return false;
        }

        if (!isDestinationAllowed(dest)) {
            notify("This place isn't part of your visit purpose. Tap Change in the sidebar if your purpose is different.", 'error');
            return false;
        }

        // After the visit is finished, only the always-visible places are
        // allowed (checked above) and nothing more is logged.
        if (finished) return true;

        const key = destinationKey(dest);
        if (logged.has(key)) return true;              // already logged this place

        const info = describeDestination(dest);
        const entry = {
            visitId: null, name: info.name, coords: destinationCoords(dest),
            arrived: false, arrivedPending: false, promptDone: false
        };
        logged.set(key, entry);

        // Navigation is never blocked if logging fails (e.g. weak signal).
        fetch('/api/visits/purpose', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: session.userId,
                destinationName: info.name,
                destinationType: info.type,
                buildingName: info.building,
                purpose: current.purpose,
                details: current.details || null
            })
        })
            .then(res => res.json())
            .then(data => {
                if (!data?.ok || !data.visit?.id) return;
                entry.visitId = data.visit.id;
                if (entry.arrivedPending) {
                    entry.arrivedPending = false;
                    reportArrival(entry);
                }
            })
            .catch(err => console.warn('Could not log visit purpose:', err));

        return true;
    }

    function clear() {
        expiryTimers.forEach(clearTimeout);
        expiryTimers = [];
        expiresAt = null;
        current = null;
        finished = false;
        checkedOut = false;
        scopeApplied = false;
        logged.clear();
        clearTimeout(donePromptTimer);
        closeDonePrompt();
        if (modal) closeModal(null);
        document.getElementById('vpChip')?.remove();
    }

    window.ensureVisitPurpose = ensureVisitPurpose;
    window.VisitPurpose = {
        ensureDailyPurpose,
        applyScope,
        changePurpose,
        finishVisit: () => openDonePrompt(null),
        offerReactivation,
        isWithinAccessHours,
        clear,
        getCurrent: () => current,
        isFinished: () => finished
    };
})();