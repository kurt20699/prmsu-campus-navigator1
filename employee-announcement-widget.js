/* ============================================================
    employee-announcement-widget.js
    Lets Employees click the Alert Banner to submit an announcement
    for Admin review. Self-contained: injects its own modal + styles.
    Does not touch the existing banner cycling logic in script.js.
    ============================================================ */

    (function () {
    const AUTH_SESSION_KEY = 'campusNavigatorSession';

    function getSession() {
        try { return JSON.parse(localStorage.getItem(AUTH_SESSION_KEY)); }
        catch { return null; }
    }

    function isEmployee(session) {
        return !!session && String(session.role || '').toUpperCase() === 'EMPLOYEE';
    }

    // ── Inject styles ──
    const style = document.createElement('style');
    style.textContent = `
        #alertBanner.employee-clickable {
        cursor: pointer;
        transition: box-shadow 0.2s, transform 0.15s;
        position: relative;
        padding-bottom: 32px !important;
        min-height: 172px;
        }
        @media (max-width: 768px) {
        #alertBanner.employee-clickable {
            height: auto;
            min-height: 0;
        }
        }
        #alertBanner.employee-clickable:hover {
        box-shadow: 0 4px 16px rgba(44,90,160,0.18);
        transform: translateY(-1px);
        }
        #eaw-hint-badge {
        position: absolute;
        left: 14px;
        bottom: 8px;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        font-weight: 700;
        color: #2c5aa0;
        background: #e8f0fe;
        padding: 2px 8px;
        border-radius: 999px;
        white-space: nowrap;
        letter-spacing: 0.2px;
        }
        #eaw-overlay {
        display:none; position:fixed; inset:0; z-index:3000;
        background:rgba(15,58,82,0.4); align-items:center; justify-content:center;
        }
        #eaw-overlay.active { display:flex; }
        #eaw-modal {
        background:white; border-radius:16px; width:90%; max-width:420px;
        padding:24px; box-shadow:0 8px 32px rgba(15,58,82,0.25);
        font-family:"Sora","Segoe UI",sans-serif;
        }
        #eaw-modal h3 { margin:0 0 4px; font-size:17px; color:#0f3a52; }
        #eaw-modal .eaw-sub { font-size:12px; color:#64748b; margin-bottom:16px; }
        #eaw-modal label { display:block; font-size:11px; font-weight:700; text-transform:uppercase;
        letter-spacing:0.4px; color:#64748b; margin-bottom:5px; margin-top:14px; }
        #eaw-modal textarea, #eaw-modal select, #eaw-modal input[type="datetime-local"] {
        width:100%; border:1.5px solid #e2e8f0; border-radius:8px; padding:10px 12px;
        font-size:13px; font-family:inherit; color:#1a2b3c; box-sizing:border-box; resize:vertical;
        }
        #eaw-modal textarea:focus, #eaw-modal select:focus, #eaw-modal input[type="datetime-local"]:focus {
        outline:none; border-color:#2c5aa0; box-shadow:0 0 0 3px rgba(44,90,160,0.12);
        }
        #eaw-actions { display:flex; justify-content:flex-end; gap:10px; margin-top:20px; }
        #eaw-actions button {
        padding:9px 18px; border-radius:8px; font-size:13px; font-weight:700;
        font-family:inherit; cursor:pointer; border:none;
        }
        #eaw-cancel { background:transparent; color:#64748b; border:1.5px solid #e2e8f0 !important; }
        #eaw-submit { background:#2c5aa0; color:white; }
        #eaw-submit:disabled { opacity:0.6; cursor:not-allowed; }
        #eaw-note {
        font-size:11px; color:#92400e; background:#fef3c7; padding:8px 10px;
        border-radius:8px; margin-top:14px; line-height:1.4;
        }
        #eaw-toast {
        position:fixed; bottom:22px; right:22px; padding:11px 18px; border-radius:10px;
        font-size:13px; font-weight:600; color:white; z-index:9999;
        transform:translateY(80px); opacity:0; transition:all 0.3s cubic-bezier(0.34,1.56,0.64,1);
        box-shadow:0 8px 32px rgba(15,58,82,0.14);
        }
        #eaw-toast.show { transform:translateY(0); opacity:1; }
        #eaw-toast.success { background:#16a34a; }
        #eaw-toast.error { background:#dc2626; }
    `;
    document.head.appendChild(style);

    // ── Inject modal markup ──
    const overlay = document.createElement('div');
    overlay.id = 'eaw-overlay';
    overlay.innerHTML = `
        <div id="eaw-modal">
        <h3>📢 Submit an Announcement</h3>
        <p class="eaw-sub">Your submission will be reviewed by an Admin before it's published.</p>

        <label for="eawType">Type</label>
        <select id="eawType">
            <option value="info">📢 Info / Informational Notice</option>
            <option value="warning">⚠️ Warning</option>
            <option value="emergency">🚨 Emergency</option>
        </select>

        <label for="eawMessage">Message</label>
        <textarea id="eawMessage" rows="4" maxlength="200"></textarea>

        <label for="eawExpires">Expires At (optional)</label>
        <input id="eawExpires" type="datetime-local">

        <div id="eaw-note">⏳ This post will be marked <strong>Pending</strong> until an Admin approves it. It won't be visible to other users until then.</div>

        <div id="eaw-actions">
            <button id="eaw-cancel" type="button">Cancel</button>
            <button id="eaw-submit" type="button">Submit for Review</button>
        </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const toast = document.createElement('div');
    toast.id = 'eaw-toast';
    document.body.appendChild(toast);

    function showToast(msg, type) {
        toast.textContent = msg;
        toast.className = `${type} show`;
        setTimeout(() => toast.classList.remove('show'), 3200);
    }

    const EAW_TYPE_PLACEHOLDERS = {
        info: 'e.g. The university library will be open from 7:00 AM to 8:00 PM starting next Monday.',
        warning: 'e.g. Please exercise caution when moving around the campus due to continuous heavy rainfall and slippery walkways.',
        emergency: 'e.g. A fire has been reported near the Engineering Building. Please evacuate immediately and proceed to the designated evacuation area.'
    };

    function updateEawPlaceholder() {
        const type = document.getElementById('eawType').value;
        document.getElementById('eawMessage').placeholder =
            EAW_TYPE_PLACEHOLDERS[type] || EAW_TYPE_PLACEHOLDERS.info;
    }

    function openModal() {
        document.getElementById('eawMessage').value = '';
        document.getElementById('eawType').value = 'info';
        document.getElementById('eawExpires').value = '';
        updateEawPlaceholder();
        overlay.classList.add('active');
    }
    function closeModal() {
        overlay.classList.remove('active');
    }

    document.getElementById('eaw-cancel').addEventListener('click', closeModal);
    document.getElementById('eawType').addEventListener('change', updateEawPlaceholder);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

    document.getElementById('eaw-submit').addEventListener('click', async () => {
        const message = document.getElementById('eawMessage').value.trim();
        const type = document.getElementById('eawType').value;
        const expires = document.getElementById('eawExpires').value;
        if (!message) { showToast('Please enter a message.', 'error'); return; }

        const session = getSession();
        if (!session?.userId) { showToast('Session expired — please log in again.', 'error'); return; }

        const btn = document.getElementById('eaw-submit');
        btn.disabled = true;
        btn.textContent = 'Submitting…';
        try {
        const res = await fetch('/api/announcements/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
            userId: session.userId, message, type,
            expires_at: expires ? new Date(expires).toISOString() : null
            })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Submission failed.');
        showToast('Submitted! Waiting for Admin approval.', 'success');
        closeModal();
        } catch (err) {
        showToast(err.message, 'error');
        } finally {
        btn.disabled = false;
        btn.textContent = 'Submit for Review';
        }
    });

    // Checks the submitAnnouncements feature flag via window.Permissions,
    // matching the pattern used everywhere else in script.js (e.g.
    // Permissions.canUseFeature(role, 'saveLocations')) rather than
    // hardcoding a role string here.
    function canSubmitAnnouncements(session) {
        if (!session) return false;
        if (typeof window.Permissions?.canUseFeature === 'function') {
        return window.Permissions.canUseFeature(session.role, 'submitAnnouncements');
        }
        // Fallback if permissions.js hasn't loaded for some reason
        return isEmployee(session);
    }

    function insertHintBadge(banner) {
        if (document.getElementById('eaw-hint-badge')) return; // already inserted
        const badge = document.createElement('span');
        badge.id = 'eaw-hint-badge';
        badge.textContent = '✏️ Tap to submit';
        banner.appendChild(badge);
    }

    // ── Wire up (or tear down) the banner click state based on the CURRENT
    // session. Safe to call repeatedly — e.g. once on initial page load, and
    // again right after login/logout — since it's idempotent in both
    // directions instead of only ever adding the Employee state once.
    function applyBannerState() {
        const banner = document.getElementById('alertBanner');
        if (!banner) return;
        const session = getSession();

        if (canSubmitAnnouncements(session)) {
        banner.classList.add('employee-clickable');
        banner.title = 'Click to submit an announcement for review';
        insertHintBadge(banner);
        // Guard against attaching a duplicate click listener every time
        // this runs (e.g. login → logout → login again in the same tab).
        if (!banner._eawClickBound) {
            banner.addEventListener('click', openModal);
            banner._eawClickBound = true;
        }
        } else {
        // Students/Visitors/Admin, or logged out: make sure no stale
        // Employee-only affordance is left showing from a previous session
        // in this same tab.
        banner.classList.remove('employee-clickable');
        banner.removeAttribute('title');
        document.getElementById('eaw-hint-badge')?.remove();
        }
    }

    // Kept as a thin alias — showAlert's class-list reset (see hookShowAlert
    // below) just needs the current state re-applied, same as anywhere else.
    function reapplyBannerClickableState() {
        applyBannerState();
    }

    // Wrap the existing global showAlert (defined in script.js) so our
    // clickable class survives its full class-list resets. script.js's
    // showAlert() runs banner.className = '' on every call (including the
    // 5-second alert-cycling interval), which would otherwise silently
    // strip employee-clickable a few seconds after page load.
    function hookShowAlert() {
        if (typeof window.showAlert === 'function' && !window.showAlert._eawWrapped) {
        const originalShowAlert = window.showAlert;
        window.showAlert = function (...args) {
            originalShowAlert.apply(this, args);
            reapplyBannerClickableState();
        };
        window.showAlert._eawWrapped = true;
        return true;
        }
        return false;
    }

    // ✅ Public hook — script.js calls this right after setAuthSession()/
    // startAppAfterAuth() (fresh login) and after logoutUser() (session
    // cleared), so the Submit affordance appears/disappears immediately
    // instead of only updating on the next full page refresh. This file
    // loads with `defer`, so window.EmployeeAnnouncementWidget is guaranteed
    // to exist by the time DOMContentLoaded fires in script.js's listener.
    window.EmployeeAnnouncementWidget = { refresh: applyBannerState };

    document.addEventListener('DOMContentLoaded', () => {
        applyBannerState(); // handles the "session already in localStorage on load" case
        // script.js and this file both load with `defer`, in <script> order —
        // but just in case load order ever changes, retry briefly rather than
        // silently no-op if showAlert isn't defined yet.
        if (!hookShowAlert()) {
        let attempts = 0;
        const retry = setInterval(() => {
            attempts++;
            if (hookShowAlert() || attempts > 20) clearInterval(retry);
        }, 100);
        }
    });
    })();