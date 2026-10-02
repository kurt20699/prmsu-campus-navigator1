// Application logic — campusData is provided by campus-data.js

function showAlert(message, type = 'info') {
    const banner = document.getElementById('alertBanner');
    const messageEl = document.getElementById('alertMessage');
    const iconEl = document.getElementById('alertIcon');

    if (!banner || !messageEl) {
        console.error('Alert banner elements not found!');
        return;
    }

    const icons = {
        info:      '📢',
        warning:   '⚠️',
        emergency: '🚨'
    };

    // ✅ Force remove ALL classes first, then re-add base ones
    banner.className = '';
    banner.classList.add('alert-banner');
    banner.classList.add(`alert-${type}`);

    // Update icon and message
    if (iconEl) iconEl.textContent = icons[type] || '📢';
    messageEl.textContent = message;

    // ✅ Force remove hidden
    banner.classList.remove('hidden');

    console.log('Alert shown:', type, message, banner.className);
}

// ✅ Shared visibility gate for the Campus Alerts / Campus Tips tab strip.
// Visitors get neither feature — this hides the tab container (buttons +
// the "|" separator) entirely rather than leaving an empty/dead UI element
// pointing at features a Visitor account can't use.
function applyAlertsTipsTabVisibility() {
    const tabsWrap = document.getElementById('alertsTipsTabs');
    if (!tabsWrap) return;
    const session = getAuthSession();
    const role = session?.role || 'VISITOR';
    const allowed = window.Permissions?.canUseFeature(role, 'campusAlerts')
        || window.Permissions?.canUseFeature(role, 'campusTips');
    tabsWrap.classList.toggle('hidden', !allowed);
}
window.applyAlertsTipsTabVisibility = applyAlertsTipsTabVisibility;

// Helper function to normalize coordinates to array format
function normalizeCoords(coords) {
    if (Array.isArray(coords)) {
        return coords; // Already correct format
    } else if (coords && coords.lat && coords.lng) {
        return [coords.lat, coords.lng]; // Convert object to array
    } else {
        console.error('Invalid coords format:', coords);
        return null;
    }
}

function isPointInsideBoundary(point, boundary) {
    if (!Array.isArray(boundary) || boundary.length < 3) return true;
    const [lat, lng] = point;
    let inside = false;

    for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
        const [latI, lngI] = boundary[i];
        const [latJ, lngJ] = boundary[j];

        const intersects = ((latI > lat) !== (latJ > lat)) &&
            (lng < (lngJ - lngI) * (lat - latI) / (latJ - latI) + lngI);

        if (intersects) inside = !inside;
    }

    return inside;
}

// ── Location accuracy helpers ───────────────────────────────────────────
// Turns a raw accuracy reading (meters) into a 0..1 smoothing factor: a
// precise fix (small accuracy number) pulls the displayed dot most of the
// way toward the new reading; a shaky fix barely moves it. This replaces a
// single fixed SMOOTHING constant, which treated a ±3m fix and a ±35m fix
// identically.
function smoothingFactorForAccuracy(accuracy, maxAcceptableAccuracy) {
    const confidence = 1 - Math.min(accuracy / maxAcceptableAccuracy, 1); // 1 = best, 0 = worst
    const MIN_SMOOTHING = 0.15; // even a bad-but-accepted fix still nudges the dot a little
    const MAX_SMOOTHING = 0.65; // a great fix is trusted almost fully
    return MIN_SMOOTHING + confidence * (MAX_SMOOTHING - MIN_SMOOTHING);
}

// Finds the STATIC_BUILDING_FOOTPRINTS entry (if any) that contains this
// point, reusing the same ray-casting test used for the campus boundary.
function findContainingFootprint(lat, lng) {
    const footprints = window.STATIC_BUILDING_FOOTPRINTS;
    if (!Array.isArray(footprints)) return null;
    for (const fp of footprints) {
        if (Array.isArray(fp.coords) && fp.coords.length >= 3 && isPointInsideBoundary([lat, lng], fp.coords)) {
            return fp;
        }
    }
    return null;
}

// Closest point on a polygon's edges to (lat, lng) — used to nudge the dot
// back onto a walkway when a reading lands inside a building outline, since
// a GPS drift into a building footprint is far more likely than the user
// actually being inside it while navigating outdoors.
function nearestPointOnPolygonBoundary(lat, lng, coords) {
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < coords.length - 1; i++) {
        const [lat1, lng1] = coords[i];
        const [lat2, lng2] = coords[i + 1];
        const dx = lng2 - lng1;
        const dy = lat2 - lat1;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq === 0 ? 0 : ((lng - lng1) * dx + (lat - lat1) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const candLat = lat1 + t * dy;
        const candLng = lng1 + t * dx;
        const dLat = candLat - lat;
        const dLng = candLng - lng;
        const dist = dLat * dLat + dLng * dLng;
        if (dist < bestDist) {
            bestDist = dist;
            best = [candLat, candLng];
        }
    }
    return best;
}

// MapLibre has no L.circle-in-meters equivalent, so we build the accuracy
// ring ourselves as a GeoJSON polygon (points around the center at the
// real-world radius) and render it as a fill + outline layer.
function createAccuracyCircleGeoJSON(lng, lat, radiusMeters, points = 64) {
    const coords = [];
    const earthRadius = 6371000;
    const latRad = (lat * Math.PI) / 180;

    for (let i = 0; i <= points; i++) {
        const angle = (i / points) * 2 * Math.PI;
        const dx = radiusMeters * Math.cos(angle);
        const dy = radiusMeters * Math.sin(angle);

        const dLat = dy / earthRadius;
        const dLng = dx / (earthRadius * Math.cos(latRad));

        coords.push([lng + (dLng * 180) / Math.PI, lat + (dLat * 180) / Math.PI]);
    }

    return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [coords] }
    };
}

// ── Heading smoothing — drives the flashlight beam's rotation ────────────
// Kept as standalone state (not inside the big `state` object) so this is a
// self-contained addition. `target` is the latest trusted heading; `current`
// is what's actually being displayed, eased toward `target` every animation
// frame along the SHORTEST angular path — so crossing 0°/360° (e.g. 350° →
// 10°) rotates +20°, never spins the "long way around" through 180°.
const headingAnim = { current: null, target: null, rafId: null };

// ── GPS location filter — outlier rejection + Kalman smoothing ───────────
// Lives in location-filter.js (loaded before this file). Falls back to a
// pass-through stub if that file failed to load for any reason, so a
// missing/broken script tag degrades gracefully instead of crashing
// location tracking entirely.
const locationFilter = window.LocationFilter
    ? window.LocationFilter.createLocationFilter({
        outlierOptions: { baseThresholdMeters: 30, accuracyMultiplier: 2 },
        kalmanOptions: { processNoise: 3 } // meters/sec — roughly a brisk walking pace
    })
    : {
        process: (lat, lng) => ({ lat, lng, accuracy: null }),
        reset: () => {}
    };

// GPS heading readings get noisy/unreliable below walking speed — filtering
// them out below this threshold is what stops the beam from jittering
// around while the user is essentially stationary.
const MIN_SPEED_FOR_HEADING = 0.5; // m/s

function shortestAngleDelta(from, to) {
    return ((to - from + 540) % 360) - 180;
}

function tickHeadingAnim() {
    if (headingAnim.target == null) { headingAnim.rafId = null; return; }
    if (headingAnim.current == null) headingAnim.current = headingAnim.target;

    const delta = shortestAngleDelta(headingAnim.current, headingAnim.target);
    const EASE = 0.18; // higher = snappier, lower = smoother/more damped

    if (Math.abs(delta) < 0.5) {
        headingAnim.current = headingAnim.target;
        applyUserMarkerHeadingRaw(headingAnim.current);
        headingAnim.rafId = null; // converged — stop animating (saves battery while idle)
        return;
    }

    headingAnim.current = (headingAnim.current + delta * EASE + 360) % 360;
    applyUserMarkerHeadingRaw(headingAnim.current);
    headingAnim.rafId = requestAnimationFrame(tickHeadingAnim);
}

// Sets the CSS custom property directly, no smoothing/validation — only
// ever called from tickHeadingAnim() above (or from a map 'rotate' handler
// re-applying the last known true heading, see wireHeadingToMapBearing()).
//
// `deg` is the TRUE real-world heading (0 = north, clockwise) — the same
// value regardless of how either map is currently rotated. Each map draws
// its marker in its own rotated screen space though, so the CSS var actually
// written for a given map is the true heading minus THAT map's own bearing,
// normalized back into 0–360. This is exactly what keeps the cone pointing
// at the correct real-world direction on screen even as the map spins under
// it — the same trick Google Maps uses for its blue dot.
function normalizeDeg(deg) {
    return ((deg % 360) + 360) % 360;
}

function applyUserMarkerHeadingRaw(deg) {
    if (state.userMarker && state.map) {
        const bearing = typeof state.map.getBearing === 'function' ? state.map.getBearing() : 0;
        state.userMarker.getElement().style.setProperty('--user-heading', `${normalizeDeg(deg - bearing)}deg`);
    }
    if (map3dState.userMarker && map3dState.map) {
        const bearing3d = typeof map3dState.map.getBearing === 'function' ? map3dState.map.getBearing() : 0;
        map3dState.userMarker.getElement().style.setProperty('--user-heading', `${normalizeDeg(deg - bearing3d)}deg`);
    }
}

// Re-applies the last known TRUE heading (headingAnim.current) whenever a
// map's bearing changes — e.g. the user drags the compass control or does
// a two-finger rotate — so the beam stays correctly aligned to real-world
// direction even when the compass/GPS heading itself hasn't changed at all.
// Kept as a single shared listener factory since 2D and 3D maps both need
// the identical behavior wired to their own 'rotate' event.
function wireHeadingToMapBearing(map) {
    if (!map || map._headingBearingWired) return;
    map.on('rotate', () => {
        if (headingAnim.current != null) applyUserMarkerHeadingRaw(headingAnim.current);
    });
    map._headingBearingWired = true;
}

// ✅ Public entry point — call with the latest raw heading reading (and,
// when available, the current speed). Validates the reading and starts/
// continues the smoothing animation toward it. An invalid heading, or a
// heading reported while essentially stationary, is a no-op — the beam
// simply keeps pointing in its last reliable direction instead of
// snapping to a default or rotating randomly.
function applyUserMarkerHeading(headingDeg, speed) {
    if (typeof headingDeg !== 'number' || Number.isNaN(headingDeg)) return;
    if (typeof speed === 'number' && speed < MIN_SPEED_FOR_HEADING) return;

    const deg = ((headingDeg % 360) + 360) % 360;
    headingAnim.target = deg;
    if (headingAnim.rafId == null) {
        headingAnim.rafId = requestAnimationFrame(tickHeadingAnim);
    }
}

// ── Device orientation (compass) — Google-Maps-style live rotation ───────
// Whenever the compass is actively reporting, it drives the beam directly
// (physically rotating the phone rotates the cone in real time, standing
// still or not). GPS heading (pos.coords.heading, wired in
// startNavigationLocationWatch below) is only used as a fallback when the
// compass is unsupported, permission was denied, or readings have gone
// stale — it never fights the compass for control of the beam.
const compassState = {
    active: false,          // a deviceorientation listener is currently attached
    usingAbsoluteEvent: false,
    supported: false,       // at least one real compass reading has arrived
    lastUpdate: 0
};

const COMPASS_STALE_MS = 2000; // GPS heading takes back over if compass goes quiet this long

function handleDeviceOrientation(event) {
    let heading = null;

    // iOS Safari: webkitCompassHeading is already a true-north compass
    // reading (0 = north, clockwise) — no conversion needed.
    if (typeof event.webkitCompassHeading === 'number' && !Number.isNaN(event.webkitCompassHeading)) {
        heading = event.webkitCompassHeading;
    }
    // Android/Chrome: alpha is only a reliable compass heading when the
    // browser reports it's world-absolute (either via the dedicated
    // 'deviceorientationabsolute' event, or event.absolute === true on the
    // regular event). alpha increases counter-clockwise from the device's
    // reference direction, so it's inverted to get clockwise-from-north.
    else if (typeof event.alpha === 'number' && !Number.isNaN(event.alpha) &&
             (event.absolute === true || compassState.usingAbsoluteEvent)) {
        heading = 360 - event.alpha;
    }

    if (heading == null) return;

    compassState.supported = true;
    compassState.lastUpdate = Date.now();

    // No `speed` argument — compass readings should always update the beam,
    // even while standing perfectly still (unlike noisy GPS heading, which
    // is gated by MIN_SPEED_FOR_HEADING above).
    applyUserMarkerHeading(((heading % 360) + 360) % 360);
}

// ✅ Public entry point — call synchronously from a click/tap handler only.
// iOS 13+'s DeviceOrientationEvent.requestPermission() must run inside the
// original user-gesture call stack or Safari silently rejects it, so this
// is invoked directly at the top of setUserLocation()/navigateToSelected(),
// never from inside a .then()/await continuation.
function startCompassTracking() {
    if (compassState.active) return;
    if (typeof DeviceOrientationEvent === 'undefined') return;

    const attach = () => {
        compassState.active = true;
        if ('ondeviceorientationabsolute' in window) {
            compassState.usingAbsoluteEvent = true;
            window.addEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
        } else {
            window.addEventListener('deviceorientation', handleDeviceOrientation, true);
        }
    };

    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS — must prompt; denial/failure just means we keep relying on
        // GPS heading, which is already wired up as a fallback.
        DeviceOrientationEvent.requestPermission()
            .then(response => { if (response === 'granted') attach(); })
            .catch(() => {});
    } else {
        // Android / desktop — no permission prompt required.
        attach();
    }
}

function updateUserLocationMarker(lat, lng, accuracy, options = {}) {
    const { showPopup = false, pan = false } = options;

    if (!state.userMarker) {
        const el = document.createElement('div');
        el.className = 'user-location-marker';
        el.style.width = '30px';   // matches .user-marker-pulse's size — without this,
        el.style.height = '30px';  // MapLibre can't compute the -50%/-50% centering offset correctly
        el.innerHTML = `
            <div class="user-marker-beam"></div>
            <div class="user-marker-pulse"></div>
            <div class="user-marker-dot"></div>
        `;

        state.userMarker = new maplibregl.Marker({ element: el })
            .setLngLat([lng, lat])
            .addTo(state.map);
    } else {
        state.userMarker.setLngLat([lng, lat]);
    }

    if (typeof accuracy === 'number') {
        const circleGeoJSON = createAccuracyCircleGeoJSON(lng, lat, accuracy);

        if (!state.map.getSource('accuracy-circle')) {
            state.map.addSource('accuracy-circle', { type: 'geojson', data: circleGeoJSON });

            state.map.addLayer({
                id: 'accuracy-circle-fill',
                type: 'fill',
                source: 'accuracy-circle',
                paint: { 'fill-color': '#4285f4', 'fill-opacity': 0.1 }
            });

            state.map.addLayer({
                id: 'accuracy-circle-outline',
                type: 'line',
                source: 'accuracy-circle',
                paint: { 'line-color': '#4285f4', 'line-width': 2, 'line-opacity': 0.5 }
            });
        } else {
            state.map.getSource('accuracy-circle').setData(circleGeoJSON);
        }
        state.accuracyCircle = true; // flag only — real state now lives in the map source/layers
    }

    if (showPopup) {
        const popup = new maplibregl.Popup({ offset: 20 }).setHTML(`
            <div style="text-align: center;">
                <strong>📍 Your Location</strong><br>
                ${typeof accuracy === 'number' ? `<small>Accuracy: ±${Math.round(accuracy)}m</small>` : ''}
            </div>
        `);
        state.userMarker.setPopup(popup);
        openMarkerPopup(state.userMarker);
    }

    if (pan) {
        state.map.flyTo({ center: [lng, lat], zoom: 18, duration: 1200 });
    }

    // ✅ Keep the 3D map's user-location marker in lockstep with the 2D one.
    // Every caller of updateUserLocationMarker() (initial fix, watchPosition
    // updates, arrival, "locate me" taps) already flows through here, so
    // hooking the 3D sync at this single choke point means no other call
    // site needs to change — same approach as the accuracy circle above.
    // Guarded on map3dState.map existing (not map3dState.active) so the
    // marker is already in place and current the moment the user switches
    // into 3D view, rather than waiting for the next GPS reading.
    if (map3dState.map) {
        sync3DUserLocationMarker(lat, lng);
    }
}

// Removes the user marker + accuracy circle layer/source cleanly.
function removeUserLocationMarker() {
    if (state.userMarker) {
        state.userMarker.remove();
        state.userMarker = null;
    }
    if (state.map.getLayer('accuracy-circle-fill')) state.map.removeLayer('accuracy-circle-fill');
    if (state.map.getLayer('accuracy-circle-outline')) state.map.removeLayer('accuracy-circle-outline');
    if (state.map.getSource('accuracy-circle')) state.map.removeSource('accuracy-circle');
    state.accuracyCircle = null;
    remove3DUserLocationMarker();
}

// Turns a raw GeolocationPositionError into a user-facing message.
// Kept standalone so every stage below (and any future caller) reports
// errors the same way instead of re-deriving this message inline.
function describeGeoError(error) {
    if (!error) return 'Unable to get your location';
    // error.code === 0 is our own synthetic "not supported" error, which
    // already carries its own message — pass it through untouched.
    if (error.code === 0 && error.message) return error.message;
    switch (error.code) {
        case 1: // PERMISSION_DENIED
            return 'Location permission denied. Please enable location access for this site/app in your device settings.';
        case 2: // POSITION_UNAVAILABLE
            return 'Location information unavailable. Please check that GPS/Location Services are turned on.';
        case 3: // TIMEOUT
            return 'Location request timed out. Please try again.';
        default:
            return 'Unable to get your location. Please try again.';
    }
}

// ── Location permission flow ─────────────────────────────────────────
// Mirrors the "explain first, then trigger the real OS prompt" pattern
// apps like Messenger use. This never fakes a permission grant/denial —
// it only decides WHEN to call the real navigator.geolocation API, and
// shows explanatory UI around that call. The actual grant/deny always
// comes from the browser/OS itself.
let _geoPermissionPanelStyleInjected = false;
function ensureGeoPermissionPanelStyle() {
    if (_geoPermissionPanelStyleInjected) return;
    _geoPermissionPanelStyleInjected = true;
    const style = document.createElement('style');
    style.id = 'geo-permission-panel-styles';
    style.textContent = `
        #geoPermissionOverlay {
            position: fixed;
            inset: 0;
            background: rgba(15,58,82,0.4);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 4000;
        }
        #geoPermissionModal, #geoBlockedPanel {
            background: #fff;
            border-radius: 14px;
            width: min(360px, calc(100vw - 32px));
            padding: 20px 22px;
            box-shadow: 0 8px 32px rgba(15,58,82,0.25);
            font-family: system-ui, sans-serif;
        }
        #geoPermissionModal h4, #geoBlockedPanel h4 {
            margin: 0 0 8px;
            font-size: 15px;
            color: #0f3a52;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        #geoPermissionModal p, #geoBlockedPanel p {
            margin: 0 0 10px;
            font-size: 12.5px;
            color: #374151;
            line-height: 1.5;
        }
        #geoPermissionModal ul, #geoBlockedPanel ol {
            margin: 0 0 14px;
            padding-left: 18px;
            font-size: 12.5px;
            color: #374151;
            line-height: 1.6;
        }
        #geoPermissionActions, #geoBlockedActions {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
        }
        #geoPermissionActions button, #geoBlockedActions button {
            border: none;
            border-radius: 8px;
            padding: 8px 16px;
            font-size: 12.5px;
            font-weight: 600;
            cursor: pointer;
            font-family: inherit;
        }
        #geoPermissionNotNow, #geoBlockedDismiss {
            background: transparent;
            color: #64748b;
            border: 1.5px solid #e2e8f0 !important;
        }
        #geoPermissionAllow {
            background: #1e3a8a;
            color: #fff;
        }
        #geoBlockedPanel {
            position: fixed;
            left: 50%;
            bottom: 24px;
            transform: translateX(-50%);
            z-index: 4000;
        }
    `;
    document.head.appendChild(style);
}

// Shows the explainer BEFORE the real browser prompt. Tapping "Allow
// Location" is what fires onAllow(), which is what actually calls
// navigator.geolocation — this modal itself has no power to grant
// anything.
function showLocationPermissionExplainer(onAllow, onNotNow) {
    ensureGeoPermissionPanelStyle();
    document.getElementById('geoPermissionOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'geoPermissionOverlay';
    overlay.innerHTML = `
        <div id="geoPermissionModal">
            <h4>📍 Allow PRMSU Smart Campus Navigator to access your location?</h4>
            <p>Your location is used for:</p>
            <ul>
                <li>Find My Location</li>
                <li>Live location tracking while you walk</li>
                <li>Turn-by-turn navigation and directions</li>
            </ul>
            <div id="geoPermissionActions">
                <button type="button" id="geoPermissionNotNow">Not Now</button>
                <button type="button" id="geoPermissionAllow">Allow Location</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('geoPermissionNotNow').addEventListener('click', () => {
        overlay.remove();
        onNotNow?.();
    });
    document.getElementById('geoPermissionAllow').addEventListener('click', () => {
        overlay.remove();
        onAllow(); // real navigator.geolocation call happens inside this, from THIS click
    });
}

function getGeoBlockedSteps() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/.test(ua);
    const isAndroid = /Android/.test(ua);

    if (isIOS) {
        return [
            'Open the Settings app on your device.',
            'Scroll down and tap Safari (or your browser).',
            'Tap Location, then choose "Allow" or "Ask Next Time".',
            'Reload this page and try again.'
        ];
    }
    if (isAndroid) {
        return [
            'Tap the 🔒 lock icon next to the address bar.',
            'Tap Permissions, then Location.',
            'Choose "Allow" and reload this page.',
            'If it\'s still blocked, check Settings > Apps > (your browser) > Permissions > Location.'
        ];
    }
    return [
        'Click the 🔒 lock icon in the address bar.',
        'Find Location in the site permissions list.',
        'Change it to "Allow" and reload this page.'
    ];
}

// Persistent guidance panel for an already-denied origin. Retrying
// navigator.geolocation here would just return PERMISSION_DENIED again
// silently, so this points the user at the one place that can actually
// fix it: their own settings.
function showLocationBlockedInstructions() {
    ensureGeoPermissionPanelStyle();
    document.getElementById('geoBlockedPanel')?.remove();

    const steps = getGeoBlockedSteps();
    const panel = document.createElement('div');
    panel.id = 'geoBlockedPanel';
    panel.innerHTML = `
        <h4>📍 Location is blocked for this site</h4>
        <p>Your browser has location access turned off for this site. This can only be fixed in your settings — reloading or retrying won't help.</p>
        <ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol>
        <div id="geoBlockedActions">
            <button type="button" id="geoBlockedDismiss">Got it</button>
        </div>
    `;
    document.body.appendChild(panel);
    document.getElementById('geoBlockedDismiss').addEventListener('click', () => panel.remove());
}

// Resolves to 'granted' | 'denied' | 'prompt' | 'unsupported'. Centralizes
// the Permissions API check so this stays the single source of truth
// instead of duplicating navigator.permissions logic at each call site.
function getGeoPermissionState() {
    if (!navigator.permissions || !navigator.permissions.query) {
        return Promise.resolve('unsupported');
    }
    return navigator.permissions.query({ name: 'geolocation' })
        .then((status) => status.state)
        .catch(() => 'unsupported');
}

// ── Location-blocked instructions panel ─────────────────────────────
// A hard PERMISSION_DENIED (error.code === 1) can never be fixed by
// retrying — the browser/OS has the origin blocked and only the user
// can change that in their settings. A 3-second toast isn't enough
// room to explain how, so this shows a dismissible panel with
// device-specific steps instead. Self-contained (injects its own
// style once), same pattern as ai-chat-widget.js / employee-
// announcement-widget.js.
let _geoBlockedPanelStyleInjected = false;
function ensureGeoBlockedPanelStyle() {
    if (_geoBlockedPanelStyleInjected) return;
    _geoBlockedPanelStyleInjected = true;
    const style = document.createElement('style');
    style.id = 'geo-blocked-panel-styles';
    style.textContent = `
        #geoBlockedPanel {
            position: fixed;
            left: 50%;
            bottom: 24px;
            transform: translateX(-50%);
            width: min(360px, calc(100vw - 32px));
            background: #fff;
            border-radius: 12px;
            box-shadow: 0 8px 30px rgba(0,0,0,0.3);
            padding: 16px 18px;
            z-index: 4000;
            font-family: system-ui, sans-serif;
        }
        #geoBlockedPanel h4 {
            margin: 0 0 6px;
            font-size: 14px;
            color: #0f3a52;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        #geoBlockedPanel p {
            margin: 0 0 8px;
            font-size: 12.5px;
            color: #374151;
            line-height: 1.45;
        }
        #geoBlockedPanel ol {
            margin: 0 0 10px;
            padding-left: 18px;
            font-size: 12.5px;
            color: #374151;
            line-height: 1.5;
        }
        #geoBlockedPanel button {
            background: #1e3a8a;
            color: #fff;
            border: none;
            border-radius: 8px;
            padding: 7px 14px;
            font-size: 12.5px;
            cursor: pointer;
        }
    `;
    document.head.appendChild(style);
}

function getGeoBlockedSteps() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/.test(ua);
    const isAndroid = /Android/.test(ua);

    if (isIOS) {
        return [
            'Open the Settings app on your device.',
            'Scroll down and tap Safari (or your browser).',
            'Tap Location, then choose "Allow" or "Ask Next Time".',
            'Reload this page and try again.'
        ];
    }
    if (isAndroid) {
        return [
            'Tap the 🔒 lock icon next to the address bar.',
            'Tap Permissions, then Location.',
            'Choose "Allow" and reload this page.',
            'If it\'s still blocked, check Settings > Apps > (your browser) > Permissions > Location.'
        ];
    }
    return [
        'Click the 🔒 lock icon in the address bar.',
        'Find Location in the site permissions list.',
        'Change it to "Allow" and reload this page.'
    ];
}

function showLocationBlockedInstructions() {
    ensureGeoBlockedPanelStyle();
    document.getElementById('geoBlockedPanel')?.remove();

    const steps = getGeoBlockedSteps();
    const panel = document.createElement('div');
    panel.id = 'geoBlockedPanel';
    panel.innerHTML = `
        <h4>📍 Location is blocked for this site</h4>
        <p>Your browser has location access turned off for this site. This can only be fixed in your settings — reloading or retrying won't help.</p>
        <ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol>
        <button type="button" id="geoBlockedDismiss">Got it</button>
    `;
    document.body.appendChild(panel);
    document.getElementById('geoBlockedDismiss').addEventListener('click', () => panel.remove());
}

// One-time check on load so the app knows ahead of time whether
// location is already blocked, before the user even taps "Find My
// Location". Not all browsers support the Permissions API (notably
// older iOS Safari) — silently no-ops there, falling back to the
// existing per-request error handling.
function checkGeoPermissionOnLoad() {
    if (!navigator.permissions || !navigator.permissions.query) return;
    navigator.permissions.query({ name: 'geolocation' }).then((status) => {
        if (status.state === 'denied') {
            showLocationBlockedInstructions();
        }
        status.onchange = () => {
            if (status.state === 'denied') {
                showLocationBlockedInstructions();
            } else {
                document.getElementById('geoBlockedPanel')?.remove();
            }
        };
    }).catch(() => {});
}

document.addEventListener('DOMContentLoaded', checkGeoPermissionOnLoad);

// Runs a single watchPosition attempt for up to `waitMs`, resolving with the
// most accurate reading seen ({ position, error }). `highAccuracy` controls
// whether we ask for GPS (slower, precise) or network/WiFi-based positioning
// (faster first fix, coarser — used as a fallback when GPS is slow/unavailable).
//
// ✅ `goodEnoughAccuracy`/`goodEnoughAfterMs` let a merely-decent fix short-
// circuit the wait instead of always holding out for `desiredAccuracy`. The
// live watchPosition + Kalman filter (started right after acquisition)
// keeps refining the position in real time anyway, so the first fix doesn't
// need to be perfect — it just needs to be good enough to start showing the
// user something and let route/distance calculation begin.
function watchPositionOnce({ highAccuracy, waitMs, desiredAccuracy, goodEnoughAccuracy, goodEnoughAfterMs }) {
    return new Promise((resolve) => {
        let best = null;
        let watchId = null;
        let settled = false;
        const startedAt = Date.now();

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            if (watchId !== null) navigator.geolocation.clearWatch(watchId);
            resolve(result);
        };

        const timeoutId = setTimeout(() => {
            if (best) {
                finish({ position: best, error: null });
            } else {
                finish({ position: null, error: { code: 3, message: 'Location request timed out. Please try again.' } });
            }
        }, waitMs);

        try {
            watchId = navigator.geolocation.watchPosition(
                (position) => {
                    if (!best || position.coords.accuracy < best.coords.accuracy) {
                        best = position;
                    }
                    if (position.coords.accuracy <= desiredAccuracy) {
                        finish({ position: best, error: null });
                        return;
                    }
                    // ✅ Don't make the user wait out the full stage timeout
                    // for an ideal fix if a decent one already showed up —
                    // accept anything within goodEnoughAccuracy once a short
                    // grace period has passed, since live tracking keeps
                    // refining the position afterward regardless.
                    if (goodEnoughAccuracy &&
                        position.coords.accuracy <= goodEnoughAccuracy &&
                        Date.now() - startedAt >= (goodEnoughAfterMs || 0)) {
                        finish({ position: best, error: null });
                    }
                },
                (error) => {
                    // A hard permission denial can't be fixed by waiting longer —
                    // give up on this stage immediately (still returning any
                    // best-so-far reading, just in case one arrived first).
                    if (error && error.code === 1) {
                        finish({ position: best, error: { code: 1, message: describeGeoError(error) } });
                        return;
                    }
                    // Otherwise, a single error callback (e.g. a transient
                    // POSITION_UNAVAILABLE blip) doesn't mean the watch is
                    // dead — some GPS chipsets report a failure once, then
                    // recover a moment later. Keep waiting for the timeout
                    // if we already have a reading; only finish early with
                    // an error if we truly have nothing yet AND the watch
                    // itself isn't going to keep trying (handled by timeout).
                    if (best) return;
                },
                { enableHighAccuracy: highAccuracy, timeout: waitMs, maximumAge: highAccuracy ? 0 : 60000 }
            );
        } catch (err) {
            // Some browsers throw synchronously (rare, but seen on older
            // Android WebViews) instead of invoking the error callback.
            finish({ position: null, error: { code: 2, message: describeGeoError({ code: 2 }) } });
        }
    });
}

/**
 * Reliable, cross-device location acquisition with automatic retry and
 * fallback. Tries, in order:
 *   1. High-accuracy GPS (handles slow/cold GPS fixes by watching for
 *      up to `maxWaitMs` and keeping the best reading seen).
 *   2. One retry of high-accuracy GPS (covers transient failures — brief
 *      signal loss, a chipset that needs a second attempt to lock).
 *   3. A low-accuracy fallback (network/WiFi-based positioning), for
 *      devices/environments where GPS hardware is unavailable, disabled,
 *      or unreasonably slow (e.g. indoors, some older Android devices).
 * A hard PERMISSION_DENIED short-circuits immediately (retrying/falling
 * back can never fix a denied permission, so surface that error right away
 * instead of making the user wait through every stage).
 *
 * `onStatus(message)` is called before each stage so the caller can show
 * an accurate loading state — the final error message is only produced
 * after every stage has been exhausted.
 */
function acquireAccurateLocation({ desiredAccuracy = 25, maxWaitMs = 7000, onStatus } = {}) {
    if (!navigator.geolocation) {
        return Promise.resolve({ position: null, error: { code: 0, message: 'Geolocation is not supported by your browser' } });
    }

    const notify = (msg) => { if (typeof onStatus === 'function') onStatus(msg); };

    const stages = [
        // ✅ goodEnoughAccuracy/goodEnoughAfterMs: accept a decent (not
        // necessarily ideal) fix after a short grace period rather than
        // always waiting the full stage timeout — this is the main lever
        // for making "Find My Location" feel fast, since most devices
        // report a usable ~30-60m fix within 1-3s, well before they'd
        // ever tighten to the old fixed 25m threshold.
        { highAccuracy: true, waitMs: maxWaitMs, label: 'Getting your precise location…', goodEnoughAccuracy: desiredAccuracy * 2, goodEnoughAfterMs: 1500 },
        { highAccuracy: true, waitMs: Math.max(maxWaitMs, 8000), label: 'Still trying for a GPS fix…', goodEnoughAccuracy: desiredAccuracy * 3, goodEnoughAfterMs: 2000 },
        { highAccuracy: false, waitMs: 10000, label: 'Falling back to approximate location…' }
    ];

    return (async () => {
        let lastResult = null;
        let bestOverall = null; // best reading seen across ALL stages, not just the current one

        for (const stage of stages) {
            notify(stage.label);
            lastResult = await watchPositionOnce({
                highAccuracy: stage.highAccuracy,
                waitMs: stage.waitMs,
                desiredAccuracy,
                goodEnoughAccuracy: stage.goodEnoughAccuracy,
                goodEnoughAfterMs: stage.goodEnoughAfterMs
            });

            // Permission denials can't be fixed by retrying or falling back —
            // stop immediately instead of making the user wait ~25s to be
            // told the same thing three times.
            if (lastResult.error && lastResult.error.code === 1) return lastResult;

            if (lastResult.position) {
                if (!bestOverall || lastResult.position.coords.accuracy < bestOverall.coords.accuracy) {
                    bestOverall = lastResult.position;
                }
                // ✅ Only stop early if this reading actually hit the target
                // precision — otherwise a coarse early fix (common during
                // GPS warm-up) gets accepted immediately instead of giving
                // later stages a chance to refine it further.
                if (lastResult.position.coords.accuracy <= desiredAccuracy) {
                    return { position: lastResult.position, error: null };
                }
            }
        }

        // All stages exhausted — return the best reading seen across every
        // stage (not the last stage's result, which deliberately uses the
        // least accurate mode as a final fallback), or the last error if
        // nothing usable ever arrived.
        return bestOverall
            ? { position: bestOverall, error: null }
            : lastResult;
    })();
}

function getCampusUserLocation(campus) {
    if (!navigator.geolocation) {
        showNotification('Geolocation is not supported by your browser', 'error');
        return Promise.resolve(null);
    }

    return acquireAccurateLocation().then(({ position, error }) => {
        if (!position) {
            // A hard denial can't be fixed by retrying, and a 3s toast isn't
            // enough room to explain how to fix it — show the persistent,
            // device-specific instructions panel instead.
            if (error && error.code === 1) {
                showLocationBlockedInstructions();
            } else {
                showNotification(error?.message || 'Unable to get your location', 'error');
            }
            return null;
        }
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const accuracy = position.coords.accuracy;
        const inside = isPointInsideBoundary([lat, lng], campus.boundary);
        return { coords: [lat, lng], accuracy, inside };
    });
}

// State Management - UPDATED with new properties
const state = {
    map: null,
    currentCampus: null,
    _routeRecordedThisNav: false,
        // ✅ NEW Multi-stop v2
    multiStop: {
        active: false,
        stops: [],           // { location, status: 'pending'|'current'|'done', cachedRoute: null }
        currentIndex: 0,
        countdownTimer: null,
        arrivalChecker: null,
        paleLayerIds: []      // map layer/source ids for the "other stops" preview lines
    },  
    markers: [],
    routeLine: null,
    dashedOverlay: null,
    routingControl: null,
    userMarker: null,
    accuracyCircle: null,
    userLocation: null,
    watchId: null,
    deadReckoning: {           // ✅ predicts dot position between real GPS fixes
        active: false,
        rafId: null,
        baseLat: null,
        baseLng: null,
        baseTime: null,
        speed: null,            // meters/second, from the OS's own fused sensors
        heading: null,          // degrees, 0 = north, clockwise
        accuracy: null
    },
    selectedLocation: null,
    accessibleOnly: false,
    currentFilter: 'all',
    savedLocations: [],
    routeHistory: [],
    trees: [],          // ✅ ADD — cached rows from GET /api/trees, drawn by add3DTrees()
    currentRoute: null,
    routeAnimation: null,
    campusBoundary: null,
    isRoomNavigation: false,
    directPathLine: null,
    lastRoomBuilding: null,
    navigationMode: 'route',
    navigationBuilding: null,
    // 'auto' = old distance-based behavior (walking near campus, driving
    // far away). Overridden by the Walk/Car/Bike buttons in the route panel.
    travelMode: 'foot', // ✅ Default to Walk so route details show immediately on
                         // navigate, instead of waiting for a manual Walk/Car/Bike tap

    rooms: {
        markers: [],           // Array of room markers
        activeBuilding: null,  // Currently displayed building
        layerGroup: null      // Layer group for room markers
    }

};

// Loading Screen
function showLoadingScreen() {
    const loadingScreenEl = document.getElementById('loadingScreen');
    loadingScreenEl.classList.add('active');
    restartLoadingBarAnimation(loadingScreenEl);
}

function restartLoadingBarAnimation(loadingScreenEl) {
    const bar = loadingScreenEl.querySelector('.loading-progress');
    if (!bar) return;
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = '';
}

function hideLoadingScreen() {
    document.getElementById('loadingScreen').classList.remove('active');
}

const AUTH_USERS_KEY = 'campusNavigatorUsers';
const AUTH_SESSION_KEY = 'campusNavigatorSession';
const AUTH_RESET_KEY = 'campusNavigatorResetState';

function getStoredUsers() {
    try {
        return JSON.parse(localStorage.getItem(AUTH_USERS_KEY)) || [];
    } catch (error) {
        console.error('Unable to parse users from storage:', error);
        return [];
    }
}

function saveStoredUsers(users) {
    localStorage.setItem(AUTH_USERS_KEY, JSON.stringify(users));
}

function getAuthSession() {
    try {
        return JSON.parse(localStorage.getItem(AUTH_SESSION_KEY));
    } catch (error) {
        console.error('Unable to parse auth session:', error);
        return null;
    }
}

function setAuthSession(session) {
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
}

function getResetState() {
    try {
        return JSON.parse(localStorage.getItem(AUTH_RESET_KEY));
    } catch (error) {
        console.error('Unable to parse reset state:', error);
        return null;
    }
}

function setResetState(resetState) {
    localStorage.setItem(AUTH_RESET_KEY, JSON.stringify(resetState));
}

function clearResetState() {
    localStorage.removeItem(AUTH_RESET_KEY);
}

function clearLoginInputs() {
    const loginIdentifierInput = document.getElementById('loginEmail');
    const loginPasswordInput = document.getElementById('loginPassword');
    if (loginIdentifierInput) loginIdentifierInput.value = '';
    if (loginPasswordInput) loginPasswordInput.value = '';
}

function updateUserRoleBadge() {
    const roleBadge = document.getElementById('currentUserRole');
    if (!roleBadge) return;
    const session = getAuthSession();
    roleBadge.textContent = session?.role ? session.role : 'Guest';
}

function applyRolePermissions() {
    const session = getAuthSession();
    const role = session?.role || 'VISITOR';

    // Hide category filter buttons for types this role can't access
    document.querySelectorAll('.category-btn').forEach(btn => {
        const type = btn.dataset.filter;
        const allowed = type === 'all' || Permissions.canAccessLocationType(role, type);
        btn.style.display = allowed ? '' : 'none';
    });

    // Gate quick-action buttons by feature flag
    const featureByAction = {
        savedLocations: 'saveLocations',
        multiStop: 'multiStop'
    };
    document.querySelectorAll('.quick-access-btn').forEach(btn => {
        const feature = featureByAction[btn.dataset.action];
        if (feature) {
            btn.style.display = Permissions.canUseFeature(role, feature) ? '' : 'none';
        }
    });
}

function logoutUser() {

    disconnectRealtimeStream();
    localStorage.removeItem(AUTH_SESSION_KEY);
    window.VisitPurpose?.clear();
    window.EmployeeAnnouncementWidget?.refresh();

    // ✅ Logging out drops back to Visitor rules — re-hide Campus Alerts/Tips
    // immediately instead of leaving them visible until a page refresh.
    if (window._alertCycleInterval) {
        clearInterval(window._alertCycleInterval);
        window._alertCycleInterval = null;
    }
    document.getElementById('alertBanner')?.classList.add('hidden');
    applyAlertsTipsTabVisibility();
    window.CampusTipsWidget?.refresh();

    const profilePanel = document.getElementById('profilePanel');
    const profilePanelOverlay = document.getElementById('profilePanelOverlay');
    if (profilePanel) {
        profilePanel.classList.remove('open');
        profilePanel.style.display = 'none';
    }
    if (profilePanelOverlay) {
        profilePanelOverlay.style.display = 'none';
    }

    document.getElementById('mainApp')?.classList.add('hidden');
    document.getElementById('authScreen')?.classList.remove('hidden');
    document.getElementById('mobileMenuToggle')?.classList.add('hidden');
    document.getElementById('logoutModal')?.classList.remove('active');
    document.getElementById('sidebarOverlay')?.classList.remove('active');
    document.body.classList.remove('sidebar-open');
    hideLoadingScreen();

    const sidebar = document.getElementById('sidebarPanel') ?? document.getElementById('sidebar');
    if (sidebar) sidebar.classList.remove('open', 'active');

    // Close building panel, location modal, virtual tour if any were open
    document.getElementById('buildingPanel')?.classList.remove('active', 'open');
    document.getElementById('locationModal')?.classList.remove('active');
    const virtualTourModal = document.getElementById('virtualTourModal');
    if (virtualTourModal) virtualTourModal.remove();

    updateUserRoleBadge();
    switchAuthTab('login');
    clearLoginInputs();
    showNotification('Logged out successfully.', 'success');
}

function confirmLogout() {
    const logoutModal = document.getElementById('logoutModal');
    if (!logoutModal) {
        if (window.confirm('Continue to log out?')) {
            logoutUser();
        }
        return;
    }
    logoutModal.classList.add('active');
}

function switchAuthTab(tabName) {
    document.querySelectorAll('.auth-tab-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.authTab === tabName);
    });

    document.getElementById('loginForm')?.classList.toggle('hidden', tabName !== 'login');
    document.getElementById('registerForm')?.classList.toggle('hidden', tabName !== 'register');
    document.getElementById('forgotForm')?.classList.toggle('hidden', tabName !== 'forgot');
    document.querySelector('.auth-tabs')?.classList.toggle('hidden', tabName === 'forgot');

    if (tabName === 'login') {
        clearLoginInputs();
    }

    if (tabName === 'forgot') {
        updateForgotProgress(1);
        document.getElementById('forgotStep1')?.classList.remove('hidden');
        document.getElementById('forgotStep2')?.classList.add('hidden');
        document.getElementById('forgotStep3')?.classList.add('hidden');
    }
}

function getPasswordStrengthError(password) {
    if (!password || password.length < 8) return 'Password must be at least 8 characters long.';
    if (!/[A-Z]/.test(password)) return 'Password must include at least one uppercase letter.';
    if (!/[a-z]/.test(password)) return 'Password must include at least one lowercase letter.';
    if (!/\d/.test(password)) return 'Password must include at least one number.';
    if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include at least one special character.';
    return null;
}

function getPasswordCriteria(password) {
    return {
        len: password.length >= 8,
        upper: /[A-Z]/.test(password),
        lower: /[a-z]/.test(password),
        digit: /\d/.test(password),
        special: /[^A-Za-z0-9]/.test(password)
    };
}

function updatePasswordRulesList(listElement, password) {
    if (!listElement) return;
    const criteria = getPasswordCriteria(password);
    const isEmpty = password.length === 0;

    listElement.querySelectorAll('[data-rule]').forEach((listItem) => {
        const key = listItem.getAttribute('data-rule');
        listItem.classList.remove('rule-ok', 'rule-fail', 'rule-neutral');
        if (isEmpty) {
            listItem.classList.add('rule-neutral');
        } else {
            listItem.classList.add(criteria[key] ? 'rule-ok' : 'rule-fail');
        }
    });
}

function updatePasswordMatchLine(matchElement, primaryPassword, confirmPassword) {
    if (!matchElement) return;
    matchElement.classList.remove('match-ok', 'match-fail', 'match-empty');
    if (!confirmPassword) {
        matchElement.textContent = '';
        matchElement.classList.add('match-empty');
        return;
    }
    if (primaryPassword === confirmPassword) {
        matchElement.textContent = 'Passwords match';
        matchElement.classList.add('match-ok');
    } else {
        matchElement.textContent = 'Passwords do not match';
        matchElement.classList.add('match-fail');
    }
}

function bindPasswordLiveFeedback(passwordInputId, rulesListId, confirmInputId, matchElementId) {
    const passwordElement = document.getElementById(passwordInputId);
    const rulesElement = document.getElementById(rulesListId);
    const confirmElement = confirmInputId ? document.getElementById(confirmInputId) : null;
    const matchElement = matchElementId ? document.getElementById(matchElementId) : null;
    if (!passwordElement || !rulesElement) return;

    const refresh = () => {
        updatePasswordRulesList(rulesElement, passwordElement.value);
        if (confirmElement && matchElement) {
            updatePasswordMatchLine(matchElement, passwordElement.value, confirmElement.value);
        }
    };

    passwordElement.addEventListener('input', refresh);
    if (confirmElement) confirmElement.addEventListener('input', refresh);
    refresh();
}

function updateForgotProgress(step) {
    const progressSteps = [
        document.getElementById('forgotProgress1'),
        document.getElementById('forgotProgress2'),
        document.getElementById('forgotProgress3')
    ];

    progressSteps.forEach((node, index) => {
        if (!node) return;
        const currentStep = index + 1;
        node.classList.remove('is-active', 'is-done');
        if (currentStep < step) node.classList.add('is-done');
        if (currentStep === step) node.classList.add('is-active');
    });
}

function generateRoleBasedUserId(role, users) {
    const normalizedRole = (role || '').toLowerCase();
    const rolePrefixMap = {
        student: 'STU',
        employee: 'EMP',
        visitor: 'VIS'
    };
    const prefix = rolePrefixMap[normalizedRole] || 'USR';

    const nextSequence = users.reduce((max, entry) => {
        const rawId = (entry.userId || entry.userid || '').toString().trim().toUpperCase();
        const match = rawId.match(new RegExp(`^${prefix}-(\\d+)$`));
        if (!match) return max;
        const value = Number.parseInt(match[1], 10);
        return Number.isFinite(value) ? Math.max(max, value) : max;
    }, 0) + 1;

    return `${prefix}-${String(nextSequence).padStart(4, '0')}`;
}

async function notifyRegistrationChannels(userData) {
    try {
        const response = await fetch('/api/notify-registration', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(userData)
        });
        const result = await response.json();
        if (!response.ok) {
            return { ok: false, error: result?.error || 'Notification request failed' };
        }
        return result;
    } catch (error) {
        console.error('Registration notification error:', error);
        return { ok: false, error: 'Unable to send registration notifications' };
    }
}

// Reads a File as a base64 data URL.
function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the ID file.'));
        reader.readAsDataURL(file);
    });
}

// Shrinks a large ID photo before upload: resizes so the longest side is at
// most `maxDimension` px and re-encodes as JPEG. A 10–20 MB phone photo
// usually ends up a few hundred KB, with the ID text still readable.
// If the browser can't decode the format (e.g. some HEIC files), the
// original is returned unchanged.
async function compressIdImage(file, { maxDimension = 1600, quality = 0.82 } = {}) {
    const originalDataUrl = await readFileAsDataURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('Image could not be decoded.'));
            image.src = originalDataUrl;
        });

        const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
        const width = Math.round(img.width * scale);
        const height = Math.round(img.height * scale);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';          // white background for transparent PNGs
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        const compressed = canvas.toDataURL('image/jpeg', quality);
        return compressed.length < originalDataUrl.length ? compressed : originalDataUrl;
    } catch {
        return originalDataUrl;
    }
}

function setupAuthHandlers() {
    document.querySelectorAll('.auth-tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => switchAuthTab(btn.dataset.authTab));
    });

    const loginForm = document.getElementById('loginForm');
    const loginIdentifierType = document.getElementById('loginIdentifierType');
    const loginIdentifierLabel = document.getElementById('loginIdentifierLabel');
    const loginIdentifierInput = document.getElementById('loginEmail');
    const registerForm = document.getElementById('registerForm');
    const forgotStep1 = document.getElementById('forgotStep1');
    const forgotStep2 = document.getElementById('forgotStep2');
    const forgotStep3 = document.getElementById('forgotStep3');
    const forgotIdentifierLabel = document.getElementById('forgotIdentifierLabel');
    const forgotIdentifierInput = document.getElementById('forgotEmail');
    const forgotMethodInputs = document.querySelectorAll('input[name="resetMethod"]');

    bindPasswordLiveFeedback('registerPassword', 'registerPasswordRules', 'registerConfirmPassword', 'registerPassMatch');
    bindPasswordLiveFeedback('forgotNewPassword', 'forgotPasswordRules', 'forgotConfirmPassword', 'forgotPassMatch');

    // Role-specific label + instructions for the ID upload. The field stays
    // hidden until a role is picked, then shows only the text for that role.
    const REGISTER_ID_TEXT = {
        student: {
            label: 'Upload Student ID',
            hint: '📎 Please upload a clear photo of your valid student ID for account verification. Your account stays pending until an Admin verifies it.'
        },
        employee: {
            label: 'Upload Employee ID',
            hint: '📎 Please upload a clear photo of your valid employee ID for account verification. Your account stays pending until an Admin verifies it.'
        },
        visitor: {
            label: 'Upload Valid ID',
            hint: '📎 Please upload a clear photo of any valid government-issued, company, or school ID for identity verification. Your account stays pending until an Admin verifies it.'
        }
    };

    const registerRoleSelect = document.getElementById('registerRole');
    const refreshRegisterIdField = () => {
        const role = registerRoleSelect?.value || '';
        const text = REGISTER_ID_TEXT[role];
        const idGroup = document.getElementById('registerIdGroup');
        const idInput = document.getElementById('registerIdDocument');
        const idLabel = document.getElementById('registerIdLabel');
        const idHint = document.getElementById('registerIdHint');

        // No role chosen yet: hide the upload entirely. `required` is turned
        // off while hidden, otherwise the browser blocks submit on a field
        // the user can't see.
        idGroup?.classList.toggle('hidden', !text);
        if (idInput) idInput.required = !!text;

        if (text) {
            if (idLabel) idLabel.textContent = text.label;
            if (idHint) idHint.textContent = text.hint;
        }
    };
    registerRoleSelect?.addEventListener('change', refreshRegisterIdField);
    refreshRegisterIdField();

    const refreshLoginIdentifier = () => {
        const selectedType = loginIdentifierType?.value || 'email';
        if (!loginIdentifierLabel || !loginIdentifierInput) return;
        if (selectedType === 'userId') {
            loginIdentifierLabel.textContent = 'User ID';
            loginIdentifierInput.placeholder = 'Enter your user ID';
        } else {
            loginIdentifierLabel.textContent = 'Email';
            loginIdentifierInput.placeholder = 'Enter your email';
        }
    };

    loginIdentifierType?.addEventListener('change', refreshLoginIdentifier);
    refreshLoginIdentifier();

    // SMS DISABLED — identifier field is always email now
    const refreshForgotIdentifier = () => {
        // const selectedMethod = document.querySelector('input[name="resetMethod"]:checked')?.value || 'email';
        if (!forgotIdentifierLabel || !forgotIdentifierInput) return;
        /*
        if (selectedMethod === 'sms') {
            forgotIdentifierLabel.textContent = 'Phone Number';
            forgotIdentifierInput.placeholder = 'Enter your mobile number';
            forgotIdentifierInput.type = 'tel';
            forgotIdentifierInput.inputMode = 'tel';
        } else {
        */
            forgotIdentifierLabel.textContent = 'Email';
            forgotIdentifierInput.placeholder = 'Enter your registered email';
            forgotIdentifierInput.type = 'email';
            forgotIdentifierInput.inputMode = 'email';
        // }
    };

    forgotMethodInputs.forEach((input) => {
        input.addEventListener('change', refreshForgotIdentifier);
    });
    refreshForgotIdentifier();

    loginForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const identifierType = loginIdentifierType?.value || 'userId';
        const identifierRaw = loginIdentifierInput?.value.trim() || '';
        const identifier = identifierType === 'email'
            ? identifierRaw.toLowerCase()
            : identifierRaw;
        const password = document.getElementById('loginPassword').value;

        if (!identifier) {
            showNotification('Please enter your login identifier', 'error');
            return;
        }
        
        // ✅ Validate format matches selected type
        if (identifierType === 'email') {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(identifier)) {
                showNotification('Please enter a valid email address', 'error');
                return;
            }
        } else {
            // userId mode — reject anything that looks like an email
            if (identifier.includes('@')) {
                showNotification('Please enter a User ID, not an email address', 'error');
                return;
            }
        }
        
        let user = null;
        let loginServerError = null;
        let loginServerCode = null;
        let loginCanRequest = false;
        try {
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier, password })
            });
            const result = await response.json();
            if (response.ok && result?.ok && result.user) {
                user = result.user;
            } else if (result?.error) {
                loginServerError = result.error;
                loginServerCode = result.code || null;
                loginCanRequest = !!result.canRequest;
            }
        } catch (error) {
            console.error('Database login failed, using local fallback:', error);
        }

        // Only fall back to old local accounts when the server couldn't be
        // reached — never when it answered "no" (expired, pending, rejected…).
        if (!user && !loginServerError) {
            // Fallback for legacy local accounts created before DB auth integration
            user = getStoredUsers().find((entry) => {
                const normalizedEmail = (entry.email || '').toLowerCase();
                const normalizedUserId = (entry.userId || entry.userid || '').toString().trim().toLowerCase();
                const matchesIdentifier = identifierType === 'email'
                    ? normalizedEmail === identifier
                    : normalizedUserId === identifier.toLowerCase();
                return matchesIdentifier && entry.password === password;
            });
        }

        if (!user) {
            // Expired Visitor account (after 5:00 PM) — offer to request access again.
            if (loginServerCode === 'VISITOR_EXPIRED' && window.VisitPurpose?.offerReactivation) {
                window.VisitPurpose.offerReactivation({ identifier, password, message: loginServerError, canRequest: loginCanRequest });
                return;
            }
            if (loginServerError) {
                showNotification(loginServerError, 'error');
            } else {
                const label = identifierType === 'email' ? 'email' : 'user ID';
                showNotification(`Invalid ${label} or password`, 'error');
            }
            return;
        }

        setAuthSession({
            userId: user.userId || user.userid,
            name: user.name,
            email: user.email,
            role: user.role
        });
        clearLoginInputs();
        showNotification(`Welcome back, ${user.name}!`, 'success');
        
        // ✅ Admin redirect
        if ((user.role || '').toUpperCase() === 'ADMIN') {
            window.location.href = '/admin.html';
        } else {
            startAppAfterAuth();
        }
    });

        registerForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const name = document.getElementById('registerName').value.trim();
        const email = document.getElementById('registerEmail').value.trim().toLowerCase();
        const role = document.getElementById('registerRole').value;
        const isVisitor = role === 'visitor';
        const password = document.getElementById('registerPassword').value;
        const confirmPassword = document.getElementById('registerConfirmPassword').value;
        const idFileInput = document.getElementById('registerIdDocument');
        const idFile = idFileInput?.files?.[0];

        if (!name || !email || !role || !password) {
            showNotification('Please complete all registration fields', 'error');
            return;
        }

        if (!idFile) {
            showNotification(isVisitor ? 'Please upload a photo of a valid ID' : 'Please upload a photo of your Student ID or Employee ID', 'error');
            return;
        }
        if (idFile.size > 25 * 1024 * 1024) {
            showNotification('ID photo is too large. Please upload a file under 25MB.', 'error');
            return;
        }

        if (password !== confirmPassword) {
            showNotification('Passwords do not match', 'error');
            return;
        }

        const passwordError = getPasswordStrengthError(password);
        if (passwordError) {
            showNotification(passwordError, 'error');
            return;
        }

        try {
            const idDocument = await compressIdImage(idFile);

            // Only happens if the browser couldn't shrink the image (unsupported
            // format) AND the original is very large.
            if (idDocument.length > 15 * 1024 * 1024) {
                showNotification('This photo could not be compressed. Please upload a JPG or PNG image instead.', 'error');
                return;
            }

            const response = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, role, password, idDocument })
            });
            const result = await response.json();
            if (!response.ok || !result?.ok) {
                showNotification(result?.error || 'Registration failed. Please try again.', 'error');
                return;
            }

            const registeredUser = result.user;
            const emailFailed = result.notifications?.email !== 'sent';

            if (emailFailed) {
                showNotification(`Account created (User ID: ${registeredUser.userId}), but the verification email could not be sent. Please contact the campus admin.`, 'error');
            } else if (result.verificationStatus === 'approved') {
                showNotification(`Account created! Your User ID is ${registeredUser.userId}. Check your email and click the verification link, then log in.`, 'success');
            } else {
                showNotification(`Account created. Your User ID is ${registeredUser.userId}. Verify your email, then wait for admin approval of your ID before logging in.`, 'success');
            }

            registerForm.reset();
            refreshRegisterIdField();
            localStorage.removeItem(AUTH_SESSION_KEY);
            document.getElementById('mainApp')?.classList.add('hidden');
            document.getElementById('authScreen')?.classList.remove('hidden');
            document.getElementById('mobileMenuToggle')?.classList.add('hidden');
            updateUserRoleBadge();
            switchAuthTab('login');
        } catch (error) {
            console.error('Registration API error:', error);
            showNotification('Unable to connect to server. Registration was not saved to database.', 'error');
        }
    });

    forgotStep1?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const selectedMethod = document.querySelector('input[name="resetMethod"]:checked')?.value || 'email';
        const identifierRaw = forgotIdentifierInput?.value.trim() || '';
        const identifier = selectedMethod === 'email'
            ? identifierRaw.toLowerCase()
            : identifierRaw;
        if (!identifier) {
            const label = selectedMethod === 'email' ? 'email' : 'phone number';
            showNotification(`Please enter your ${label}`, 'error');
            return;
        }

        try {
            const response = await fetch('/api/auth/forgot/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier, method: selectedMethod })
            });
            const result = await response.json();
            if (!response.ok || !result?.ok) {
                showNotification(result?.error || 'Unable to send reset code', 'error');
                return;
            }

            const expiresIn = Number(result?.expiresInSeconds) || 300;
            const resetIdentifier = result?.identifier || (selectedMethod === 'email' ? identifier : identifierRaw);
            const resetEmail = result?.email || (selectedMethod === 'email' ? resetIdentifier : '');
            if (!resetIdentifier) {
                showNotification('Unable to start reset session. Please try again.', 'error');
                return;
            }
            setResetState({
                identifier: resetIdentifier,
                email: resetEmail,
                method: selectedMethod,
                expiresAt: Date.now() + expiresIn * 1000
            });

            forgotStep1.classList.add('hidden');
            forgotStep2?.classList.remove('hidden');
            forgotStep3?.classList.add('hidden');
            updateForgotProgress(2);
            showNotification(`OTP sent via ${selectedMethod.toUpperCase()}.`, 'success');
        } catch (error) {
            console.error('Forgot password request failed:', error);
            showNotification('Unable to reach server. Please try again.', 'error');
        }
    });

    forgotStep2?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const resetState = getResetState();
        const enteredOtp = document.getElementById('forgotOtp').value.trim();

        if (!resetState || Date.now() > resetState.expiresAt) {
            clearResetState();
            showNotification('OTP expired. Please request a new code.', 'error');
            switchAuthTab('forgot');
            return;
        }

        try {
            const response = await fetch('/api/auth/forgot/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    identifier: resetState.identifier || resetState.email,
                    email: resetState.email,
                    method: resetState.method,
                    otp: enteredOtp
                })
            });
            const result = await response.json();
            if (!response.ok || !result?.ok) {
                showNotification(result?.error || 'Invalid OTP code', 'error');
                return;
            }

            setResetState({
                ...resetState,
                resetToken: result.resetToken
            });

            forgotStep2.classList.add('hidden');
            forgotStep3?.classList.remove('hidden');
            updateForgotProgress(3);
            showNotification('OTP verified. You can now reset your password.', 'success');
        } catch (error) {
            console.error('OTP verification failed:', error);
            showNotification('Unable to verify OTP. Please try again.', 'error');
        }
    });

    forgotStep3?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const resetState = getResetState();
        if (!resetState) {
            showNotification('Reset session not found. Please restart forgot password.', 'error');
            switchAuthTab('forgot');
            return;
        }

        if (!resetState.resetToken) {
            showNotification('OTP verification missing. Please restart forgot password.', 'error');
            switchAuthTab('forgot');
            return;
        }

        const newPassword = document.getElementById('forgotNewPassword').value;
        const confirmPassword = document.getElementById('forgotConfirmPassword').value;

        if (newPassword !== confirmPassword) {
            showNotification('Passwords do not match', 'error');
            return;
        }

        const passwordError = getPasswordStrengthError(newPassword);
        if (passwordError) {
            showNotification(passwordError, 'error');
            return;
        }

        try {
            const response = await fetch('/api/auth/forgot/reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    identifier: resetState.identifier || resetState.email,
                    email: resetState.email,
                    method: resetState.method,
                    resetToken: resetState.resetToken,
                    newPassword
                })
            });
            const result = await response.json();
            if (!response.ok || !result?.ok) {
                showNotification(result?.error || 'Password reset failed', 'error');
                return;
            }

            clearResetState();
            forgotStep3.reset();
            forgotStep2?.reset?.();
            forgotStep1?.reset?.();
            showNotification('Password updated. Please login.', 'success');
            switchAuthTab('login');
        } catch (error) {
            console.error('Password reset failed:', error);
            showNotification('Unable to reset password. Please try again.', 'error');
        }
    });
}

function startAppAfterAuth() {
    document.getElementById('authScreen')?.classList.add('hidden');
    showLoadingScreen();
    setupAdaptiveViewport();

        setTimeout(async () => {
        try {
            loadSavedData();

            // Visitors choose today's purpose of visit before the map loads.
            // The server then only sends the places tied to that purpose.
            if (window.VisitPurpose && !(await window.VisitPurpose.ensureDailyPurpose())) {
                return; // visitor chose "Log out" instead
            }

            await syncBuildingsFromDB();
            await syncRoomsFromDB();
            window.VisitPurpose?.applyScope();
            await syncTreesFromDB();

            // ✅ Restore profile avatar on app load
            const session = getAuthSession();
            if (session?.userId) {
                const extras = profileGetExtras(session.userId);
                profileRenderAvatar(session.name, extras.photo || null);
            }
            setupEventListeners();
            updateClock();
            setInterval(updateClock, 1000);
            hideLoadingScreen();
            loadCampus('iba');
            updateUserRoleBadge();
            applyRolePermissions();

            // ✅ Re-check the Employee "click banner to submit" affordance now
            // that the session is live. employee-announcement-widget.js only
            // evaluates this once on its own DOMContentLoaded — which, since
            // login doesn't reload the page, fires before setAuthSession() has
            // run and so always saw a logged-out state. Without this call the
            // Submit button/badge only appeared after a manual page refresh.
            window.EmployeeAnnouncementWidget?.refresh();

            // ✅ Same reasoning as above, for Campus Tips: campus-tips.js's
            // own init() only evaluates the role once on DOMContentLoaded —
            // before setAuthSession() has run on a fresh login — so without
            // this call a just-unlocked Student/Employee tab would only
            // appear after a manual page refresh. loadCampus('iba') above
            // already re-evaluated the Alerts tab via applyAlertsTipsTabVisibility().
            window.CampusTipsWidget?.refresh();

            console.log('Initialization complete!');

            // ✅ Buildings/rooms added, edited, or deleted in the admin panel
            // now reflect here without needing a re-login. resyncMapWithDatabase()
            // fires instantly via connectRealtimeStream() (SSE) — see above.
            // This 15s poll is just a safety net for the rare case an SSE
            // event is missed (e.g. tab was backgrounded/throttled).
            if (window._buildingSyncInterval) clearInterval(window._buildingSyncInterval);
            window._buildingSyncInterval = setInterval(resyncMapWithDatabase, 15000);
        } catch (error) {
            console.error('Error during initialization:', error);
            alert('Error loading app: ' + error.message);
        }
    }, 1600);
}

function setupAdaptiveViewport() {
    const applyViewportHeight = () => {
        if (window._mapGestureActive) return;
        const vh = window.innerHeight * 0.01;
        document.documentElement.style.setProperty('--app-vh', `${vh}px`);
    };

    applyViewportHeight();
    window.addEventListener('resize', applyViewportHeight);
    window.addEventListener('orientationchange', () => {
        setTimeout(applyViewportHeight, 120);
    });

    window._applyViewportHeight = applyViewportHeight;
}

// Untouched copy of the buildings in campus-data.js, taken once at startup —
// before any database sync or Visitor purpose trimming. Label position and
// rotation (labelOffset), photos and tour photos only exist here, not in the
// database, so they're always restored from this copy.
const STATIC_CAMPUS_LOCATIONS = (campusData?.iba?.locations || []).map(loc => ({ ...loc }));

async function syncBuildingsFromDB() {
try {
    const session = getAuthSession();
    const url = session?.userId ? `/api/buildings?userId=${encodeURIComponent(session.userId)}` : '/api/buildings';
    const res = await fetch(url);
    const data = await res.json();

    // Only fall back to whatever's already loaded (campus-data.js baseline)
    // if the fetch itself failed — a successful-but-empty response means
    // the DB genuinely has zero buildings right now, and the map should
    // reflect that, not silently keep stale static data.
    if (!data.ok || !Array.isArray(data.buildings)) return;

    const dbBuildings = data.buildings;
    const campus = campusData['iba'];

    // Index the CURRENT locations (static + previously synced) so we can
    // preserve rich fields the DB doesn't store — image, tourPhotos, rooms,
    // labelOffset — for any building that still exists in the DB response.
    const existingByShort = {};
    const existingByName  = {};
    // Start from the original campus-data.js buildings, so a building that
    // wasn't in memory (e.g. hidden by a Visitor's previous purpose) still
    // gets its label rotation, position and photos back.
    STATIC_CAMPUS_LOCATIONS.forEach(loc => {
        if (loc.shortName) existingByShort[loc.shortName] = loc;
        existingByName[loc.name] = loc;
    });
    campus.locations.forEach(loc => {
        if (loc.shortName) existingByShort[loc.shortName] = loc;
        existingByName[loc.name] = loc;
    });

    // ✅ The final list is built ENTIRELY from dbBuildings — nothing that
    // isn't in this DB response survives. This is what makes deletions
    // actually stick after a refresh: a deleted building has no dbB entry,
    // so it's simply never added to the new array, no matter what
    // campus-data.js says.
    campus.locations = dbBuildings.map(dbB => {
        const existing = existingByShort[dbB.short_name] || existingByName[dbB.name] || null;

        return {
            // ⚠️ FIX: `id` was never set here — only `_dbId` was. Every rebuilt
            // building ended up with `id: undefined`, which made msSearchStop /
            // msNormalizeLocation compute the SAME normalized id
            // ("building_undefined") for every building in the app. Once any
            // stop was active, that single collision silently blocked EVERY
            // building from ever appearing in Add-Stop search results (not
            // just COE — all of them, for the entire session after sync ran).
            // dbB.id is the DB's own stable building id and is unique across
            // the whole table, so prefer it; keep the old static id or
            // short_name as a last-resort fallback so nothing is ever undefined.
            id: dbB.id ?? existing?.id ?? dbB.short_name,
            name: dbB.name,
            shortName: dbB.short_name,
            type: dbB.type || 'department',
            coords: (dbB.lat && dbB.lng) ? [parseFloat(dbB.lat), parseFloat(dbB.lng)] : (existing?.coords || null),
            rooms: existing?.rooms || [],
            labelOffset: existing?.labelOffset || [0, 0],
            image: existing?.image || null,
            photo: existing?.photo || null,   // ← ADD — populateBuildingPanel() filters on this field specifically
            tourPhotos: existing?.tourPhotos || [],
            description: dbB.description || existing?.description || null,
            footprint: Array.isArray(dbB.footprint) && dbB.footprint.length >= 3 ? dbB.footprint : (existing?.footprint || null),
            footprintHeight: dbB.footprint_height != null ? Number(dbB.footprint_height) : (existing?.footprintHeight ?? 4),
            _dbId: dbB.id
        };
    });

    console.log(`✅ Buildings synced from DB — ${campus.locations.length} building(s), DB is the single source of truth`);
} catch(e) {
    console.warn('Could not sync buildings from DB, using campusData defaults (offline fallback):', e);
}
}

async function syncTreesFromDB() {
try {
    const res = await fetch('/api/trees');
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.trees)) return;

    state.trees = data.trees;
    console.log(`✅ Trees synced from DB — ${state.trees.length} tree(s)`);

    if (map3dState.active && map3dState.map) {
        add3DTrees();
    }
} catch(e) {
    console.warn('Could not sync trees from DB (offline, or trees table not seeded yet):', e);
}
}

// async function syncBuildingsFromDB() {
//   try {
//     const res = await fetch('/api/buildings');
//     const data = await res.json();
//     if (!data.ok || !data.buildings) return;

//     const dbBuildings = data.buildings;
//     const campus = campusData['iba'];

//     const existingByShort = {};
//     const existingByName  = {};
//     campus.locations.forEach(loc => {
//       if (loc.shortName) existingByShort[loc.shortName] = loc;
//       existingByName[loc.name] = loc;
//     });

//     dbBuildings.forEach(dbB => {
//       let existing = existingByShort[dbB.short_name] || existingByName[dbB.name] || null;

//       if (!existing) {
//         existing = {
//           name: dbB.name,
//           shortName: dbB.short_name,
//           type: dbB.type || 'department',
//           coords: (dbB.lat && dbB.lng) ? [parseFloat(dbB.lat), parseFloat(dbB.lng)] : null,
//           rooms: [],
//           labelOffset: [0, 0],
//           image: null,
//           tourPhotos: [],
//           _dbId: dbB.id
//         };
//         campus.locations.push(existing);
//         return;
//       }

//       existing.name      = dbB.name;
//       existing.shortName = dbB.short_name;
//       existing.type      = dbB.type || existing.type;
//       if (dbB.lat && dbB.lng) existing.coords = [parseFloat(dbB.lat), parseFloat(dbB.lng)];
//       existing._dbId = dbB.id;
//     });

//     const dbShortNames = new Set(dbBuildings.map(b => b.short_name));
//     const dbNames      = new Set(dbBuildings.map(b => b.name));
//     campus.locations = campus.locations.filter(loc =>
//       dbShortNames.has(loc.shortName) || dbNames.has(loc.name) || loc._dbId
//     );

//     console.log('✅ Buildings fully synced from DB');
//   } catch(e) {
//     console.warn('Could not sync buildings from DB, using campusData defaults:', e);
//   }
// }
async function syncRoomsFromDB() {
    try {
        const session = getAuthSession();
        const url = session?.userId ? `/api/rooms?userId=${encodeURIComponent(session.userId)}` : '/api/rooms';
        const res = await fetch(url);
        const data = await res.json();
        if (!data.ok || !data.rooms) return;

        const dbRooms = data.rooms;
        const campus = campusData['iba'];

        campus.locations.forEach(location => {
        const shortName = location.shortName || '';
        const fullName  = location.name || '';

        const matched = dbRooms.filter(r =>
            r.building === shortName ||
            r.building === fullName  ||
            r.building === shortName.toUpperCase()
        );

        // ⚠️ FIX: this used to `return` early here when matched.length === 0,
        // which skipped updating location.rooms entirely. That's harmless
        // for a building that never had any DB rooms — but for a building
        // that DID have rooms and just had its last one deleted, `matched`
        // legitimately becomes [] and this early-return left the stale,
        // already-deleted room object sitting in memory forever (visible on
        // the map/list until a full page reload rebuilds campusData from
        // scratch). This bit newly-added buildings hardest since they
        // typically only have 1–2 rooms, so deleting one easily zeroes them
        // out. The DB is the single source of truth for a building's rooms
        // (same principle already used for buildings themselves), so we
        // always assign — including assigning an empty array — instead of
        // skipping.

        // Index existing campusData rooms by name to preserve any coords not in DB
        const existingByName = {};
        if (Array.isArray(location.rooms)) {
            location.rooms.forEach(r => { if (r && r.name) existingByName[r.name] = r; });
        }

        location.rooms = matched.map(dbRoom => {
            const existing = existingByName[dbRoom.name];
            const coords = (dbRoom.lat && dbRoom.lng)
            ? [parseFloat(dbRoom.lat), parseFloat(dbRoom.lng)]
            : (existing?.coords || null);
            return {
            // ⚠️ FIX: same bug as syncBuildingsFromDB's building `id` — only
            // `_dbId` was set, so every DB-synced room's `id` was undefined.
            // That collapses `room_${loc.id}_${room.id}` to the same string
            // for every room in a building, breaking msSearchStop dedup for
            // rooms the same way it broke it for buildings.
            id:         dbRoom.id ?? existing?.id,
            _dbId:      dbRoom.id,
            name:       dbRoom.name,
            floor:      dbRoom.floor || '—',
            instructor: dbRoom.instructor || null,
            coords,
            iconOffset: existing?.iconOffset || [0, 0]
            };
        }).filter(r => r.coords); // only keep rooms with coordinates

        });

        console.log('✅ Rooms fully synced from DB');
    } catch(e) {
        console.warn('Could not sync rooms from DB, using campusData defaults:', e);
    }
}

// Single entry point for "the DB changed, make the map match" — the instant
// SSE push from connectRealtimeStream() and the 15s fallback poll both call
// this, so a delete/add/edit shows up on the map without a page reload.
async function resyncMapWithDatabase() {
    await syncBuildingsFromDB();
    await syncRoomsFromDB();
    window.VisitPurpose?.applyScope();
    await syncTreesFromDB();

    if (state.map) {
        addMarkers();
        addBuildingFootprints(); // also re-syncs 2D dynamic footprints internally
    }

    // If Show Room(s) is currently open for a building, keep it in sync too.
    // ⚠️ FIX: syncBuildingsFromDB() rebuilds campus.locations with brand-new
    // object instances on every call, so comparing by object identity
    // (`loc === state.rooms.activeBuilding`) would ALWAYS fail — even when
    // the building still exists — clearing the room panel on every 15s
    // poll / SSE push. Match by shortName/name instead, same key used by
    // RoomMarkerManager.toggle() elsewhere.
    if (state.rooms.activeBuilding) {
        const activeKey = state.rooms.activeBuilding.shortName || state.rooms.activeBuilding.name;
        const freshBuilding = campusData[state.currentCampus]?.locations
            .find(loc => (loc.shortName || loc.name) === activeKey);

        if (!freshBuilding) {
            // Building itself was deleted — clear the stale room markers.
            RoomMarkerManager.clear();
        } else {
            // Building still exists — re-render its room markers from the
            // freshly synced data so a deleted/added/moved room is reflected
            // immediately instead of only on the next manual toggle.
            RoomMarkerManager.clear();
            if (freshBuilding.rooms && freshBuilding.rooms.length > 0) {
                state.rooms.activeBuilding = freshBuilding;
                RoomMarkerManager.showRoomsForBuilding(freshBuilding);
            }
            // If freshBuilding now has zero rooms, leave it cleared (already
            // done above) rather than re-showing an empty room panel.
        }
    }

    // Mirror the same cleanup on the 3D map, but only if it's actually open.
    if (map3dState.active && map3dState.map) {
        addDynamicBuildingFootprints3D();
        add3DMarkers();
        // fitBounds: false — this is a routine background resync (15s poll /
        // SSE / tab refocus), not a new route, so don't yank the camera.
        if (state.currentRoute) sync3DRoute({ fitBounds: false });
    }
}

// Lets admin.html (a same-origin iframe pointing at this page) push an
// instant "the DB changed" signal instead of waiting for the 15s poll.
window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === 'adminDataChanged') {
        resyncMapWithDatabase();
    }
});

function init() {
    console.log('Initializing app...');
    document.getElementById('mainApp')?.classList.add('hidden');
    document.getElementById('authScreen')?.classList.remove('hidden');
    setupAdaptiveViewport();
    setupAuthHandlers();

    // ✅ Only wipe the session on a real top-level visit. When this page is
    // loaded inside admin.html's "Navigate Map" iframe, it shares the same
    // origin (and therefore the same localStorage) as the admin dashboard.
    // Removing AUTH_SESSION_KEY here was silently logging the admin out
    // from underneath them and breaking route-history saving, since
    // recordRoute() checks getAuthSession() before POSTing to
    // /api/routes/record.
    const inIframe = window.self !== window.top;
    if (!inIframe) {
        localStorage.removeItem(AUTH_SESSION_KEY);
    }

    updateUserRoleBadge();
    switchAuthTab('login');
    clearResetState();

    hideLoadingScreen();
    document.getElementById('mainApp')?.classList.add('hidden');
    document.getElementById('authScreen')?.classList.remove('hidden');
}

window.logoutUser = logoutUser;
window.confirmLogout = confirmLogout;

// Clock Update
function updateClock() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    const displayMinutes = minutes < 10 ? '0' + minutes : minutes;
    document.getElementById('currentTime').textContent = `${displayHours}:${displayMinutes} ${ampm}`;
}

function loadSavedData() {
    try {
        // ✅ Namespaced by userId — previously this was one shared key for
        // every account on the browser, so route history from one login
        // silently overwrote another's (e.g. admin dashboard's embedded
        // Navigate map vs. any other logged-in session).
        const session = getAuthSession();
        const key = session?.userId ? `campusNavigatorData:${session.userId}` : 'campusNavigatorData';
        let saved = localStorage.getItem(key);
        // One-time fallback so existing users don't lose pre-existing data
        // that was saved under the old shared key.
        if (!saved) saved = localStorage.getItem('campusNavigatorData');
        if (saved) {
            const data = JSON.parse(saved);
            state.savedLocations = data.savedLocations || [];
            state.routeHistory   = data.routeHistory   || [];
        } else {
            state.savedLocations = [];
            state.routeHistory   = [];
        }
    } catch (e) {
        console.warn('Could not load saved data:', e);
        state.savedLocations = [];
        state.routeHistory   = [];
    }
}

// Save data
function saveData() {
    const session = getAuthSession();
    const key = session?.userId ? `campusNavigatorData:${session.userId}` : 'campusNavigatorData';
    localStorage.setItem(key, JSON.stringify({
        savedLocations: state.savedLocations,
        routeHistory: state.routeHistory,
        lastCampus: state.currentCampus
    }));
}

// ============================================
// 🆕 ROOM MARKER MANAGER - Clean Architecture
// ============================================

// Small popup-tracking helpers — MapLibre has no global map.closePopup() like Leaflet did,
// so we track the currently-open popup ourselves.
function openMarkerPopup(marker) {
    closeActivePopup();
    marker.togglePopup();
    state.activePopup = marker.getPopup();
}

function closeActivePopup() {
    if (state.activePopup) {
        state.activePopup.remove();
        state.activePopup = null;
    }
}

const RoomMarkerManager = {
    config: {
        iconColor: '#9c27b0',
        iconSize: 20,
        borderColor: '#ffffff',
        borderWidth: 1,
        shadowColor: 'rgba(156, 39, 176, 0.4)',
        debugMode: false
    },

    getFloorNumber(floorString) {
        const floorMap = {
            '1st': '1', '2nd': '2', '3rd': '3', '4th': '4', '5th': '5',
            'ground': 'G', 'basement': 'B'
        };
        const normalized = floorString.toLowerCase();
        for (const [key, value] of Object.entries(floorMap)) {
            if (normalized.includes(key)) return value;
        }
        return '1';
    },

    validateRoomCoords(coords, campusCenter) {
        const latDiff = Math.abs(coords[0] - campusCenter.lat);
        const lngDiff = Math.abs(coords[1] - campusCenter.lng);
        const isValid = latDiff < 0.02 && lngDiff < 0.02;
        if (!isValid && this.config.debugMode) {
            console.warn(`⚠️ Room coordinates seem far from campus:`, {
                roomCoords: coords,
                campusCenter: [campusCenter.lat, campusCenter.lng],
                latDiff: latDiff.toFixed(5),
                lngDiff: lngDiff.toFixed(5)
            });
        }
        return isValid;
    },

    createIcon(floorNumber, iconOffset = [0, 0]) {
        const { iconColor, iconSize, borderColor, borderWidth, shadowColor } = this.config;
        const xOffset = iconOffset[0] || 0;
        const yOffset = iconOffset[1] || 0;

        // Outer element — handed to maplibregl.Marker, never touch its transform ourselves.
        const outer = document.createElement('div');
        outer.style.cssText = `width: ${iconSize}px; height: ${iconSize}px;`;

        // Inner element carries the custom offset — safe, MapLibre doesn't touch this one.
        const inner = document.createElement('div');
        inner.className = 'room-marker-wrapper';
        inner.style.cssText = `
            position: relative;
            width: ${iconSize}px;
            height: ${iconSize}px;
            transform: translate(${xOffset}px, ${yOffset}px);
        `;
        inner.innerHTML = `
            <div class="room-marker-icon" style="
                width: 100%;
                height: 100%;
                background: ${iconColor};
                border: ${borderWidth}px solid ${borderColor};
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 4px 10px ${shadowColor};
                position: relative;
                z-index: 1000;
            ">
                <span style="
                    color: white;
                    font-weight: 800;
                    font-size: 13px;
                    font-family: 'Segoe UI', Arial, sans-serif;
                    text-shadow: 0 1px 2px rgba(0,0,0,0.2);
                ">R${floorNumber}</span>
            </div>
        `;

        outer.appendChild(inner);
        return outer;
    },

    createPopup(room, buildingName) {
        return `
            <div style="padding: 8px; min-width: 200px;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 2px solid ${this.config.iconColor};">
                    <span style="font-size: 24px;">🚪</span>
                    <div>
                        <h4 style="margin: 0; color: ${this.config.iconColor}; font-size: 15px; font-weight: 600;">${room.name}</h4>
                        ${room.instructor ? `<div style="font-size: 12px; color: #777; margin-top: 3px;">👨‍🏫 ${room.instructor}</div>` : ''}
                    </div>
                </div>
                <div style="margin-bottom: 8px;">
                    <div style="font-size: 13px; color: #555; margin-bottom: 4px;"><strong>🏢 Building:</strong> ${buildingName}</div>
                    <div style="font-size: 13px; color: #555;"><strong>📍 Floor:</strong> ${room.floor}</div>
                    ${room.instructor ? `<div style="font-size: 13px; color: #555; margin-top: 4px;"><strong>👨‍🏫 Instructor:</strong> ${room.instructor}</div>` : ''}
                </div>
                <button
                    onclick="RoomMarkerManager.navigateToRoom(${room.coords[0]}, ${room.coords[1]}, '${room.name.replace(/'/g, "\\'")}', ${JSON.stringify(room.id ?? null)})"
                    style="width: 100%; padding: 8px; background: linear-gradient(135deg, ${this.config.iconColor} 0%, #7b1fa2 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; transition: transform 0.2s;"
                    onmouseover="this.style.transform='translateY(-2px)'"
                    onmouseout="this.style.transform='translateY(0)'"
                >
                    🧭 Navigate to Room
                </button>
                <button
                    onclick="RoomMarkerManager.goBackToBuilding()"
                    style="width: 100%; margin-top: 6px; padding: 8px; background: #f1f3f5; color: #333; border: 1px solid #e1e5ea; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px;"
                >
                    ↩ Go Back
                </button>
            </div>
        `;
    },

    _createRoomMarker(room, building, campus) {
        if (!room.coords) return null;
        const coords = normalizeCoords(room.coords);
        if (!coords) return null;
        if (!this.validateRoomCoords(coords, campus.center)) return null;
        if (!room.floor) return null;

        const floorNumber = this.getFloorNumber(room.floor);
        const el = this.createIcon(floorNumber, room.iconOffset || [0, 0]);

        const popup = new maplibregl.Popup({ maxWidth: '250px', className: 'room-popup-styled' })
            .setHTML(this.createPopup(room, building.name));

        const marker = new maplibregl.Marker({ element: el })
            .setLngLat([coords[1], coords[0]])
            .setPopup(popup)
            .addTo(state.map);

        return marker;
    },

    showRoomsForBuilding(building) {
        if (!building.rooms || building.rooms.length === 0) return;

        const campus = campusData[state.currentCampus];
        let validRoomCount = 0;

        building.rooms.forEach(room => {
            const marker = this._createRoomMarker(room, building, campus);
            if (marker) {
                state.rooms.markers.push(marker);
                validRoomCount++;
            }
        });

        if (this.config.debugMode && validRoomCount > 0) {
            console.log(`✅ Added ${validRoomCount} rooms for ${building.name}`);
        }
    },

    show(building) {
        this.clear();

        if (!building.rooms || building.rooms.length === 0) {
            showNotification(`${building.name} has no rooms to display`, 'info');
            return;
        }

        state.rooms.activeBuilding = building;
        const campus = campusData[state.currentCampus];
        let validRoomCount = 0;

        building.rooms.forEach(room => {
            const marker = this._createRoomMarker(room, building, campus);
            if (marker) {
                state.rooms.markers.push(marker);
                validRoomCount++;
            }
        });

        const buildingCoords = normalizeCoords(building.coords);
        if (buildingCoords) {
            state.map.flyTo({
                center: [buildingCoords[1], buildingCoords[0]],
                zoom: 19,
                duration: 500
            });
        }

        if (validRoomCount > 0) {
            showNotification(`📍 Showing ${validRoomCount} room(s) in ${building.name}`, 'success');
        } else {
            showNotification(`No valid room locations found`, 'warning');
        }
    },

    clear() {
        state.rooms.markers.forEach(m => m.remove());
        state.rooms.markers = [];
        state.rooms.activeBuilding = null;
    },

    goBackToBuilding() {
        const building = state.rooms.activeBuilding;
        this.clear();
        closeActivePopup();

        if (building) {
            const coords = normalizeCoords(building.coords);
            if (coords) {
                state.map.flyTo({
                    center: [coords[1], coords[0]],
                    zoom: 19,
                    duration: 400
                });

                const marker = state.markers.find(m => {
                    const lngLat = m.getLngLat();
                    return Math.abs(lngLat.lat - coords[0]) < 0.00001 &&
                        Math.abs(lngLat.lng - coords[1]) < 0.00001;
                });

                if (marker) {
                    openMarkerPopup(marker);
                }
            }
            showNotification(`Back to ${building.name}`, 'info');
            return;
        }

        showNotification('Room markers hidden', 'info');
    },

    navigateToRoom(lat, lng, roomName, roomId) {
        const building = state.rooms.activeBuilding || null;
        const destination = {
            id: `room_${building ? building.id : 'unknownbuilding'}_${roomId ?? roomName}`,
            name: roomName,
            coords: [lat, lng],
            matchType: 'room',
            buildingName: building ? building.name : null
        };
        state.selectedLocation = destination;
        state.lastRoomBuilding = building;
        state.isRoomNavigation = true;
        state._routeRecordedThisNav = false;
        closeActivePopup();
        this.clear();

        // Respect an in-progress multi-stop trip instead of always hijacking
        // navigation — same rule the location modal's primary button follows,
        // so tapping a room marker mid-trip queues it instead of restarting.
        if (state.multiStop.active) {
            msAddLocationAsStop(destination);
        } else {
            navigateToSelected();
        }
    },

    toggle(building) {
    const buildingKey = building.shortName || building.name;
    const activeKey = state.rooms.activeBuilding
        ? (state.rooms.activeBuilding.shortName || state.rooms.activeBuilding.name)
        : null;

    if (activeKey && activeKey === buildingKey) {
        this.clear();
        showNotification('Room markers hidden', 'info');
    } else {
        this.show(building);
    }
},

    setDebugMode(enabled) {
        this.config.debugMode = enabled;
        console.log(`Room marker debug mode: ${enabled ? 'ENABLED' : 'DISABLED'}`);
    }
};

function togglePassword(inputId, btn) {
    const input = document.getElementById(inputId);
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';

    btn.innerHTML = isHidden
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
}



// Event Listeners
function setupEventListeners() {
    // ✅ Idempotency guard — startAppAfterAuth() calls this on EVERY login,
    // not just the first one (e.g. login → logout → login again, all
    // without a page refresh, since logout doesn't reload the page). The
    // elements wired up below (mobileMenuToggle, logoutBtn, search, route
    // controls, etc.) are static and persist across logout/login — they're
    // never removed or recreated — so re-running this a second time doesn't
    // add anything new, it just stacks a second, independent set of
    // listeners on top of the first.
    //
    // That's actively harmful for mobileMenuToggle specifically:
    // isSidebarTransitioning (below) is a variable local to THIS call's
    // closure, so a second call creates a second, separate copy of it. Two
    // click handlers then fire per tap, each with its own "am I mid-
    // transition?" flag that knows nothing about the other — the first
    // opens the sidebar, then the second (seeing its own flag still false)
    // immediately toggles it shut again in the same click, so the button
    // appears to do nothing at all. Skipping re-attachment entirely avoids
    // this instead of trying to keep multiple independent closures in sync.
    if (window._eventListenersInitialized) {
        console.log('Event listeners already initialized — skipping re-attachment.');
        return;
    }
    window._eventListenersInitialized = true;

    try {   
        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', (event) => {
                event.preventDefault();
                confirmLogout();
            });
        }

        // Center map button
        const centerMapBtn = document.getElementById('centerMapBtn');
        if (centerMapBtn) {
            centerMapBtn.addEventListener('click', centerMap);
        } else {
            console.warn('Center map button not found');
        }

        // Search
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', handleSearch);
        }
        
        const searchBtn = document.getElementById('searchBtn');
        if (searchBtn) {
            searchBtn.addEventListener('click', handleSearch);
        }

        // Category filters
        document.querySelectorAll('.category-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                state.currentFilter = btn.dataset.filter;
                updateMarkers();
                RoomMarkerManager.clear();
                if (map3dState.active && map3dState.map) {
                    add3DMarkers();
                }
            });
        });

        // Quick access buttons
        document.querySelectorAll('.quick-access-btn').forEach(btn => {
            btn.addEventListener('click', () => handleQuickAction(btn.dataset.action));
        });

        // Modal controls
        document.querySelectorAll('.close-modal').forEach(btn => {
            btn.addEventListener('click', () => {
                document.getElementById('locationModal').classList.remove('active');
            });
        });

        const logoutModal = document.getElementById('logoutModal');
        const cancelLogout = document.getElementById('cancelLogout');
        const confirmLogoutBtn = document.getElementById('confirmLogout');

        if (cancelLogout) {
            cancelLogout.addEventListener('click', () => {
                logoutModal?.classList.remove('active');
            });
        }

        if (confirmLogoutBtn) {
            confirmLogoutBtn.addEventListener('click', () => {
                logoutModal?.classList.remove('active');
                logoutUser();
            });
        }

        if (logoutModal) {
            logoutModal.addEventListener('click', (event) => {
                if (event.target === logoutModal) {
                    logoutModal.classList.remove('active');
                }
            });
        }

        const navigateBtn = document.getElementById('navigateBtn');
        if (navigateBtn) {
            navigateBtn.addEventListener('click', handlePrimaryLocationAction);
        }
        
        
        // UPDATED: Route controls - Two separate buttons
        const minimizeRouteBtn = document.getElementById('minimizeRoute');
        if (minimizeRouteBtn) {
            minimizeRouteBtn.addEventListener('click', minimizeRoutePanel);
        }

        const navModeMap = document.getElementById('navModeMap');
        if (navModeMap) {
            navModeMap.addEventListener('click', () => setNavigationMode('map'));
        }

        const navModeRoute = document.getElementById('navModeRoute');
        if (navModeRoute) {
            navModeRoute.addEventListener('click', () => setNavigationMode('route'));
        }

        const navMode3d = document.getElementById('navMode3d');
        if (navMode3d) {
            navMode3d.addEventListener('click', toggleNav3D);
        }

        const goBackRouteBtn = document.getElementById('goBackRoute');
        if (goBackRouteBtn) {
            goBackRouteBtn.addEventListener('click', goBackFromRoute);
        }
        
        const clearRouteBtn = document.getElementById('clearRoute');
        if (clearRouteBtn) {
            clearRouteBtn.addEventListener('click', clearRouteCompletely);
        }

        // Mobile menu
        const mobileMenuToggle = document.getElementById('mobileMenuToggle');
        const sidebar = document.getElementById('sidebar');
        const sidebarOverlay = document.getElementById('sidebarOverlay');
        let isSidebarTransitioning = false;

        const setSidebarState = (isOpen) => {
            if (!sidebar) return;
            if (isSidebarTransitioning) return;
            isSidebarTransitioning = true;

            // ✅ Keep only one overlay open at a time
            if (isOpen) {
                window.closeBuildingPanel?.();
                window.AIChatWidget?.close?.();
            }

            sidebar.classList.toggle('active', isOpen);
            document.body.classList.toggle('sidebar-open', isOpen);
            if (mobileMenuToggle) {
                mobileMenuToggle.classList.toggle('active', isOpen);
                mobileMenuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            }
            if (sidebarOverlay) {
                sidebarOverlay.classList.toggle('active', isOpen);
            }
            window.setTimeout(() => {
                isSidebarTransitioning = false;
            }, 320);
        };

        // ✅ Expose so other overlays (Buildings panel, AI chat) can close
        // the sidebar when they open.
        window.closeSidebarPanel = () => setSidebarState(false);

        const closeSidebarForMobile = () => {
            if (window.matchMedia('(max-width: 768px)').matches) {
                setSidebarState(false);
            }
        };

        if (mobileMenuToggle && sidebar) {
            mobileMenuToggle.setAttribute('aria-expanded', 'false');
            const handleSidebarToggle = (event) => {
                if (event) {
                    event.preventDefault();
                    event.stopPropagation();
                }
                setSidebarState(!sidebar.classList.contains('active'));
            };
            mobileMenuToggle.addEventListener('click', handleSidebarToggle);
            mobileMenuToggle.addEventListener('touchstart', handleSidebarToggle, { passive: false });
        }

        if (sidebarOverlay) {
            sidebarOverlay.addEventListener('click', () => {
                setSidebarState(false);
            });
        }

        window.addEventListener('resize', () => {
            if (window.matchMedia('(min-width: 769px)').matches) {
                setSidebarState(false);
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                logoutModal?.classList.remove('active');
                setSidebarState(false);
            }
        });

        const searchResults = document.getElementById('searchResults');
        if (searchResults) {
            searchResults.addEventListener('click', (event) => {
                if (event.target.closest('.search-result-item')) {
                    closeSidebarForMobile();
                }
            });
        }

        document.querySelectorAll('.category-btn, .quick-access-btn').forEach((btn) => {
            btn.addEventListener('click', closeSidebarForMobile);
        });

        // Click outside to close
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.search-section') && !e.target.closest('.search-btn')) {
                const searchResultsPanel = document.getElementById('searchResults');
                if (searchResultsPanel) {
                    searchResultsPanel.classList.add('hidden');
                }
            }
        });

        // ✅ Close the Buildings panel when tapping/clicking outside it
        document.addEventListener('click', (e) => {
            const buildingPanelEl = document.getElementById('buildingImagePanel');
            if (!buildingPanelEl || buildingPanelEl.style.display !== 'flex') return;
            if (e.target.closest('#buildingImagePanel') || e.target.closest('#buildingPanelToggle')) return;
            closeBuildingPanel();
        });
        
        console.log('Event listeners setup complete');
    } catch (error) {
        console.error('Error setting up event listeners:', error);
    }
}

function centerMap() {
    if (!state.currentCampus) return;
    const campus = campusData[state.currentCampus];

    // ✅ If 3D map is active, center that instead of the hidden 2D map
    if (map3dState.active && map3dState.map) {
        map3dState.map.flyTo({
            center: [campus.center.lng, campus.center.lat], // MapLibre uses [lng, lat]
            zoom: 16,
            pitch: 65,
            bearing: 0,
            duration: 800
        });
        showNotification('3D map centered');
        return;
    }

    if (state.map) {
        state.map.easeTo({
            center: [campus.center.lng, campus.center.lat],
            zoom: 16,
            bearing: 0,
            pitch: 0,
            duration: 600
        });
        showNotification('Map centered');
    }
}

function loadCampus(campusKey) {
    if (!getAuthSession()) {
        document.getElementById('mainApp')?.classList.add('hidden');
        document.getElementById('authScreen')?.classList.remove('hidden');
        showNotification('Please login first to access the campus navigator.', 'error');
        return;
    }

    state.currentCampus = campusKey;
    const campus = campusData[campusKey];

    document.getElementById('mainApp').classList.remove('hidden');
    document.getElementById('campusNameHeader').textContent = campus.name;
    document.getElementById('mobileMenuToggle').classList.remove('hidden');

    // Show alerts — merge hardcoded + live DB announcements
    async function loadAndShowAlerts() {
        // ✅ Visitor-only restriction — Campus Alerts is hidden entirely from
        // Visitors: no tab, no banner, no fetch to /api/announcements at all.
        // This also covers the hardcoded campus.alerts entries, not just
        // live DB announcements, since we bail out before touching either.
        applyAlertsTipsTabVisibility();
        const gateSession = getAuthSession();
        const gateRole = gateSession?.role || 'VISITOR';
        if (!window.Permissions?.canUseFeature(gateRole, 'campusAlerts')) {
            if (window._alertCycleInterval) {
                clearInterval(window._alertCycleInterval);
                window._alertCycleInterval = null;
            }
            document.getElementById('alertBanner')?.classList.add('hidden');
            const hiddenCounter = document.getElementById('alertCounter');
            if (hiddenCounter) hiddenCounter.textContent = '';
            return;
        }

        let alerts = [...(campus.alerts || [])]; // start with hardcoded
        let liveAnnouncements = [];

        try {
            // ✅ Pass userId so the server can resolve the real role via
            // getCallerRole() — without this the endpoint always saw an
            // anonymous/Visitor caller regardless of who was logged in.
            const url = gateSession?.userId
                ? `/api/announcements?active=true&userId=${encodeURIComponent(gateSession.userId)}`
                : '/api/announcements?active=true';
            const res = await fetch(url);
            const data = await res.json();
            if (data.ok && data.announcements.length) {
                liveAnnouncements = data.announcements;
                const liveAlerts = data.announcements.map(a => ({
                    type: a.type || 'info',
                    message: a.message || a.title
                }));
                alerts = [...liveAlerts, ...alerts]; // live alerts first
            }
        } catch (e) {
            console.warn('Could not load live announcements:', e);
        }

        // ✅ Always clear any previous cycle before deciding what (if
        // anything) to show next — a stale interval from a now-expired
        // alert would otherwise keep firing on a closure that no longer
        // matches what should be on screen.
        if (window._alertCycleInterval) {
            clearInterval(window._alertCycleInterval);
            window._alertCycleInterval = null;
        }

        if (alerts.length === 0) {
            // ✅ FIX — nothing left to show (e.g. the only alert just
            // expired). Hide the banner instead of leaving the last-shown
            // alert stuck on screen until a manual refresh.
            const banner = document.getElementById('alertBanner');
            if (banner) banner.classList.add('hidden');
            const counter = document.getElementById('alertCounter');
            if (counter) counter.textContent = '';
            scheduleNextAlertExpiration(liveAnnouncements);
            return;
        }

        let currentAlertIndex = 0;

        const showCurrentAlert = () => {
            const alert = alerts[currentAlertIndex];
            showAlert(alert.message, alert.type);
            const counter = document.getElementById('alertCounter');
            if (counter && alerts.length > 1) {
                counter.textContent = `${currentAlertIndex + 1} / ${alerts.length}`;
            }
        };

        showCurrentAlert();

        if (alerts.length > 1) {
            window._alertCycleInterval = setInterval(() => {
                currentAlertIndex = (currentAlertIndex + 1) % alerts.length;
                showCurrentAlert();
            }, 5000);
        }

        // ✅ ADD — schedule a precise re-check for the exact moment the
        // soonest-expiring live announcement is due, instead of relying
        // solely on the 60s fallback poll.
        scheduleNextAlertExpiration(liveAnnouncements);
    }

    // ✅ ADD — expose this so the SSE listener (and the 60s fallback poll)
    // can re-run just the alert refresh, without reloading the whole
    // campus/map via loadCampus() again.
    window.refreshCampusAlerts = loadAndShowAlerts;

    loadAndShowAlerts();
    connectRealtimeStream(); // ✅ ADD — one connection for announcements + active users + map data

    initializeMap();
    saveData();
}

// Schedules a precise re-check for exactly when the soonest-expiring live
// announcement is due to expire — this is what makes expiration feel
// instant, instead of waiting up to 60s for the fallback poll to notice.
function scheduleNextAlertExpiration(liveAnnouncements) {
    if (window._nextAlertExpirationTimeout) {
        clearTimeout(window._nextAlertExpirationTimeout);
        window._nextAlertExpirationTimeout = null;
    }

    const upcoming = (liveAnnouncements || [])
        .filter(a => a.expires_at)
        .map(a => new Date(a.expires_at).getTime())
        .filter(t => t > Date.now());

    if (!upcoming.length) return;

    const soonest = Math.min(...upcoming);
    // +250ms buffer so the recheck lands just after expiry, not right on it;
    // capped so it never exceeds setTimeout's max safe delay.
    const delay = Math.min(soonest - Date.now() + 250, 2147483000);

    window._nextAlertExpirationTimeout = setTimeout(() => {
        if (typeof window.refreshCampusAlerts === 'function') {
            window.refreshCampusAlerts();
        }
    }, delay);
}

// ── CONSOLIDATED REAL-TIME STREAM (SSE) ──
// One shared connection per tab, handling announcements, active-user
// presence, AND map data (buildings/rooms) together.
//
// ⚠️ This replaces what used to be THREE separate EventSource connections.
// Browsers cap concurrent connections per origin at 6 (HTTP/1.1). With the
// Admin Dashboard open in one tab and the Main App open in another — the
// natural way to test "does the Main App update live when I delete
// something in Admin" — three streams each would total 6 permanently-open
// connections, saturating that limit. Whichever stream connected last
// (map-data) would silently queue and never actually deliver events. That
// is why room-deletion sync could appear to work in some situations and
// not others: it depended on how many tabs/streams happened to be open
// already, not on the deletion logic itself. Multiplexing everything over
// one connection removes that ceiling entirely.
let realtimeEventSource = null;
function connectRealtimeStream() {
    if (realtimeEventSource) return; // already connected

    const session = getAuthSession();
    const params = new URLSearchParams();
    if (session?.userId) params.set('userId', session.userId);
    if (session?.role) params.set('role', session.role);
    const query = params.toString() ? `?${params.toString()}` : '';

    try {
        realtimeEventSource = new EventSource(`/api/realtime/stream${query}`);
        realtimeEventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                switch (data.type) {
                    case 'announcementsChanged':
                        if (typeof window.refreshCampusAlerts === 'function') {
                            window.refreshCampusAlerts();
                        }
                        break;
                    case 'activeUsers':
                        // Main App badge intentionally shows the flat total (all
                        // roles, admin included) — regular users don't need a
                        // role breakdown. See admin.html for the breakdown view.
                        if (typeof window.updateActiveUsersDisplay === 'function') {
                            window.updateActiveUsersDisplay(data.total);
                        }
                        break;
                    case 'mapDataChanged':
                        resyncMapWithDatabase();
                        break;
                    case 'campusTipsChanged':
                        if (typeof window.refreshCampusTips === 'function') {
                            window.refreshCampusTips();
                        }
                        break;
                    // 'connected' / heartbeat comment frames: nothing to do.
                }
            } catch { /* ignore malformed frames */ }
        };
        realtimeEventSource.onerror = () => {
            // EventSource reconnects automatically after transient network
            // errors — the fallback polls below still cover any gap.
        };
    } catch (e) {
        console.warn('Could not open realtime stream:', e);
    }

    // Safety net for time-based expiration: an announcement expiring at a
    // specific timestamp isn't a database "change" the server can push an
    // event for, so this quietly re-checks every 60s to catch that case too.
    if (!window._announcementsPollInterval) {
        window._announcementsPollInterval = setInterval(() => {
            if (typeof window.refreshCampusAlerts === 'function') {
                window.refreshCampusAlerts();
            }
        }, 60000);
    }
    // Catches anything missed while this tab was backgrounded, since
    // browsers throttle timers (and can drop SSE) on inactive tabs.
    if (!window._announcementsVisibilityListenerAdded) {
        window._announcementsVisibilityListenerAdded = true;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                if (typeof window.refreshCampusAlerts === 'function') {
                    window.refreshCampusAlerts();
                }
                resyncMapWithDatabase();
            }
        });
    }
}

function disconnectRealtimeStream() {
    if (realtimeEventSource) {
        realtimeEventSource.close();
        realtimeEventSource = null;
    }
}

// Renders the live count into the header badge (markup added in index.html).
window.updateActiveUsersDisplay = function (count) {
    const el = document.getElementById('activeUsersCount');
    if (el) el.textContent = count;
};

// `persist: true` keeps the toast on screen until the caller explicitly
// calls .dismiss() on the returned handle (or shows/updates it again) —
// used for multi-stage operations like location acquisition, where a
// fixed 3s auto-dismiss could disappear well before the operation is
// actually done. Returns a small handle so callers can update the message
// as a long-running operation progresses through stages.
function showNotification(message, type = 'info', { persist = false } = {}) {
    // Remove existing notification if any
    const existingNotif = document.querySelector('.notification-toast');
    if (existingNotif) {
        existingNotif.remove();
    }

    const notification = document.createElement('div');
    notification.className = `notification-toast ${type}`;
    notification.innerHTML = type === 'loading'
        ? `<span class="notification-spinner" aria-hidden="true"></span><span class="notification-text"></span>`
        : '';
    const textEl = notification.querySelector('.notification-text');
    if (textEl) textEl.textContent = message; else notification.textContent = message;

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.classList.add('show');
    }, 100);

    let autoDismissTimer = null;
    if (!persist) {
        autoDismissTimer = setTimeout(() => {
            notification.classList.remove('show');
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    return {
        el: notification,
        update(newMessage) {
            const t = notification.querySelector('.notification-text');
            if (t) t.textContent = newMessage; else notification.textContent = newMessage;
        },
        dismiss() {
            if (autoDismissTimer) clearTimeout(autoDismissTimer);
            notification.classList.remove('show');
            setTimeout(() => notification.remove(), 300);
        }
    };
}

// Map Initialization
function initializeMap() {
    const campus = campusData[state.currentCampus];

    if (state.map) {
        state.map.remove();
    }

    window.currentMapStyle = 'default';
    state.currentVectorBase = 'default';

    state.map = new maplibregl.Map({
        container: 'map',
        // Standard OpenStreetMap raster tiles — the one and only base map now.
        style: {
            version: 8,
            sources: {
                'osm-standard': {
                    type: 'raster',
                    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                    tileSize: 256,
                    maxzoom: 19,
                    attribution: '© OpenStreetMap contributors'
                }
            },
            layers: [
                {
                    id: 'osm-standard-layer',
                    type: 'raster',
                    source: 'osm-standard'
                }
            ]
        },
        center: [campus.center.lng, campus.center.lat], // MapLibre wants [lng, lat]
        zoom: campus.zoom,
        pitch: 0,
        bearing: 0,
        pitchWithRotate: false,
        touchPitch: false,
        maxPitch: 0,
        minPitch: 0
    });

    // ✅ Keyboard's Shift+Up/Down pitch shortcut isn't covered by
    // pitchWithRotate/touchPitch above — disable it explicitly so 2D
    // truly can't be tilted from any input source.
    state.map.keyboard.disableRotation();

    state.map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    wireHeadingToMapBearing(state.map); // keep the beam locked to true north as the map rotates

    // MapLibre doesn't auto-detect container size changes like Leaflet did —
    // without this, markers/tiles get left behind at old screen positions
    // whenever the map's container resizes (sidebar toggle, window resize, 2D/3D switch, etc.)
    if (state.mapResizeObserver) {
        state.mapResizeObserver.disconnect();
    }
    if (state._mapResizeRaf) {
        cancelAnimationFrame(state._mapResizeRaf);
        state._mapResizeRaf = null;
    }
    state._lastMapSize = null;

    const mapContainer = document.getElementById('map');
    if (mapContainer && window.ResizeObserver) {
        state.mapResizeObserver = new ResizeObserver((entries) => {
            const box = entries[0]?.contentBoxSize?.[0];
            const w = box ? Math.round(box.inlineSize) : Math.round(mapContainer.clientWidth);
            const h = box ? Math.round(box.blockSize) : Math.round(mapContainer.clientHeight);

            if (state._lastMapSize && state._lastMapSize.w === w && state._lastMapSize.h === h) {
                return;
            }
            state._lastMapSize = { w, h };

            if (window._mapGestureActive) {
                window._mapResizePending = true;
                return;
            }

            if (state._mapResizeRaf) cancelAnimationFrame(state._mapResizeRaf);
            state._mapResizeRaf = requestAnimationFrame(() => {
                state._mapResizeRaf = null;
                state.map.resize();
            });
        });
        state.mapResizeObserver.observe(mapContainer);
    }

    if (mapContainer && !mapContainer._gestureTrackingBound) {
        mapContainer.addEventListener('touchstart', () => {
            window._mapGestureActive = true;
        }, { passive: true });

        const endGesture = () => {
            window._mapGestureActive = false;
            window._applyViewportHeight?.();
            if (window._mapResizePending) {
                window._mapResizePending = false;
                state.map.resize();
            }
        };
        mapContainer.addEventListener('touchend', endGesture, { passive: true });
        mapContainer.addEventListener('touchcancel', endGesture, { passive: true });
        mapContainer._gestureTrackingBound = true;
    }

    // ✅ Everything downstream (drawCampusBoundary, addMarkers, addBuildingFootprints)
    // still expects a loaded map, so wait for the style to be ready.
    state.map.on('load', () => {
        drawCampusBoundary();
        addMarkers();
        addBuildingFootprints();

        state.baseStyleLayerIds = state.map.getStyle().layers.map(l => l.id);

        // Satellite raster layer, toggled via switchMapStyle('satellite').
        if (!state.map.getSource('osm-satellite')) {
            state.map.addSource('osm-satellite', {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                // ✅ Esri's imagery resolution varies by region — z19 isn't
                // captured for this campus's area, and requesting it directly
                // returned a "no data" placeholder tile instead of real
                // imagery. Capping back at 17 (confirmed available here) lets
                // MapLibre overzoom/stretch that tile for closer zooms instead.
                maxzoom: 17,
                attribution: '© Esri, Maxar, Earthstar Geographics'
            });
        }
        if (!state.map.getLayer('tile-satellite')) {
            state.map.addLayer({
                id: 'tile-satellite',
                type: 'raster',
                source: 'osm-satellite',
                layout: { visibility: window.currentMapStyle === 'satellite' ? 'visible' : 'none' }
            });
        }
    });
}


// Draw campus boundary with red outline like the example
function drawCampusBoundary() {
    const campus = campusData[state.currentCampus];
    if (!campus.boundary) return;

    // GeoJSON needs [lng, lat] — campus.boundary is stored as [lat, lng], so flip it.
    // Also close the ring (GeoJSON polygons must start/end on the same point).
    const ring = campus.boundary.map(([lat, lng]) => [lng, lat]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
        ring.push(first);
    }

    const boundaryGeoJSON = {
        type: 'Feature',
        properties: { name: campus.name },
        geometry: {
            type: 'Polygon',
            coordinates: [ring]
        }
    };

    // Remove old boundary layer/source if it exists (e.g. campus switch or re-init)
    if (state.map.getLayer('campus-boundary-line')) {
        state.map.removeLayer('campus-boundary-line');
    }
    if (state.map.getSource('campus-boundary')) {
        state.map.removeSource('campus-boundary');
    }

    state.map.addSource('campus-boundary', {
        type: 'geojson',
        data: boundaryGeoJSON
    });

    // Outline only, no fill — matches the original transparent-fill polygon
    state.map.addLayer({
        id: 'campus-boundary-line',
        type: 'line',
        source: 'campus-boundary',
        layout: {
            'line-join': 'round',
            'line-cap': 'round'
        },
        paint: {
            'line-color': '#ff0000',
            'line-width': 4,
            'line-opacity': 0.9
        }
    });

    // Keep a reference for later removal, matching the old state.campusBoundary usage
    state.campusBoundary = { sourceId: 'campus-boundary', layerId: 'campus-boundary-line' };

    // Popup on click (Leaflet's bindPopup has no direct equivalent on a line layer)
    state.map.on('click', 'campus-boundary-line', () => {
        new maplibregl.Popup()
            .setLngLat(state.map.getCenter())
            .setHTML(`
                <div style="text-align: center; padding: 5px;">
                    <strong style="color: #2c5aa0;">🏫 ${campus.name}</strong><br>
                    <small style="color: #666;">Campus Boundary</small>
                </div>
            `)
            .addTo(state.map);
    });
    // Hover effect (Leaflet's .leaflet-interactive:hover has no CSS equivalent here —
    // MapLibre renders this layer on canvas, not as a DOM element, so the
    // cursor + fade need to be done via map events instead).
    state.map.on('mouseenter', 'campus-boundary-line', () => {
        state.map.getCanvas().style.cursor = 'pointer';
        state.map.setPaintProperty('campus-boundary-line', 'line-opacity', 0.6);
    });

    state.map.on('mouseleave', 'campus-boundary-line', () => {
        state.map.getCanvas().style.cursor = '';
        state.map.setPaintProperty('campus-boundary-line', 'line-opacity', 0.9);
    });
}

function addBuildingFootprints() {
    if (state.currentCampus !== 'iba') return;
    if (!state.map) return;

    const staticFootprints = window.STATIC_BUILDING_FOOTPRINTS;
    const rawFootprints = Array.isArray(staticFootprints) && staticFootprints.length
        ? staticFootprints.map(fp => fp.coords)
        : [
            [
                [15.3184896278243, 119.98260163024466],
                [15.3184896278243, 119.98315193024466],
                [15.3178269278243, 119.98315193024466],
                [15.3178269278243, 119.98260163024466],
                [15.3184896278243, 119.98260163024466]
            ],
            [
                [15.3168232, 119.98287],
                [15.3164785, 119.983269],
                [15.3165142, 119.9833059],
                [15.3168676, 119.982914],
                [15.3168232, 119.98287]
            ],
            [
                [15.3173787, 119.9839472],
                [15.3172786, 119.9840524],
                [15.3176078, 119.9843723],
                [15.3177089, 119.9842647],
                [15.3173787, 119.9839472]
            ],
            [
                [15.3177853, 119.9818858],
                [15.3178525, 119.9819593],
                [15.3180204, 119.9817904],
                [15.3179582, 119.9817195],
                [15.3177853, 119.9818858]
            ]
        ];

    // Flip [lat, lng] -> [lng, lat] for GeoJSON
    const featureCollection = {
        type: 'FeatureCollection',
        features: rawFootprints.map(ring => ({
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'Polygon',
                coordinates: [ring.map(([lat, lng]) => [lng, lat])]
            }
        }))
    };

    // ✅ ROOT CAUSE OF THE FLICKER/SHIFT GLITCH: this function is called on
    // every resyncMapWithDatabase() run — a 15s interval PLUS an instant call
    // on every admin add/edit/delete anywhere in the app (see setInterval(
    // resyncMapWithDatabase, 15000) and the postMessage handler). The static
    // footprint set here never changes (it comes from the constant
    // window.STATIC_BUILDING_FOOTPRINTS), so the old code was destroying and
    // recreating these layers from scratch on every single one of those
    // calls — a visible flash on every 15s tick, and a layer-order shift
    // every time (re-adding a layer always puts it back on top of the paint
    // stack, so its draw order relative to markers/routes/dynamic footprints
    // silently changed each resync).
    //
    // Fix: build the source + layers ONCE, then no-op on subsequent calls —
    // exactly the pattern addDynamicBuildingFootprints2D() already uses via
    // setData() for the parts of the map that actually DO change.
    if (state.map.getSource('building-footprints')) {
        // Static data never changes at runtime, so there's nothing to
        // update — just leave the existing source/layers exactly as they are.
        addDynamicBuildingFootprints2D();
        return;
    }

    state.map.addSource('building-footprints', {
        type: 'geojson',
        data: featureCollection
    });

    state.map.addLayer({
        id: 'building-footprints-fill',
        type: 'fill',
        source: 'building-footprints',
        paint: {
            'fill-color': '#d9d0c9 ',
            'fill-opacity': 1
        }
    });

    state.map.addLayer({
        id: 'building-footprints-outline',
        type: 'line',
        source: 'building-footprints',
        paint: {
            'line-color': '#af9e94',
            'line-width': 1
        }
    });

    // Kept for other code that still checks this — now just a flag, not Leaflet layer objects
    window._buildingFootprints = ['building-footprints-fill', 'building-footprints-outline'];

    console.log('✅ Footprints created:', featureCollection.features.length);

    // ✅ Dynamic footprints — buildings added/edited via the admin panel and
    // synced from the DB (see syncBuildingsFromDB). Separate source/layers so
    // the static set above is untouched.
    addDynamicBuildingFootprints2D();
}

function addDynamicBuildingFootprints2D() {
    const campus = campusData[state.currentCampus];
    if (!state.map || !campus) return;

    // Same palette used for markers (2D) and dynamic 3D footprints, so a
    // building's color is consistent everywhere it appears on the map.
    const typeColors = {
        administration: '#2c5aa0',
        department:     '#34a853',
        facilities:     '#fbbc04',
        office:         '#ea4335',
        landmark:       '#9c27b0'
    };

    const dynamicFeatures = (campus.locations || [])
        .filter(loc => Array.isArray(loc.footprint) && loc.footprint.length >= 3)
        .map(loc => {
            const ring = loc.footprint.map(([lat, lng]) => [lng, lat]);
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
            return {
                type: 'Feature',
                properties: {
                    name: loc.name,
                    type: loc.type,
                    color: '#d9d0c9'
                },
                geometry: { type: 'Polygon', coordinates: [ring] }
            };
        });

    const dynamicFC = { type: 'FeatureCollection', features: dynamicFeatures };

    if (state.map.getSource('dynamic-building-footprints-2d')) {
        state.map.getSource('dynamic-building-footprints-2d').setData(dynamicFC);
        return;
    }

    if (!dynamicFeatures.length) return;

    state.map.addSource('dynamic-building-footprints-2d', { type: 'geojson', data: dynamicFC });

    // ✅ These layers can be created lazily well after the initial map load —
    // e.g. the first time an admin adds a building with a footprint, which
    // might happen while the user is already in Satellite View (this runs
    // on every resyncMapWithDatabase() tick, not just on page load). Without
    // this, a newly-added building's footprint would briefly flash visible
    // in Satellite View before the next style switch hid it.
    const initialVisibility = window.currentMapStyle === 'satellite' ? 'none' : 'visible';

    state.map.addLayer({
        id: 'dynamic-building-footprints-2d-fill',
        type: 'fill',
        source: 'dynamic-building-footprints-2d',
        layout: { visibility: initialVisibility },
        paint: { 'fill-color': '#d9d0c9', 'fill-opacity': 1 }
    });

    state.map.addLayer({
        id: 'dynamic-building-footprints-2d-outline',
        type: 'line',
        source: 'dynamic-building-footprints-2d',
        layout: { visibility: initialVisibility },
        paint: { 'line-color': '#af9e94', 'line-width': 1 }
    });
}

const MAP_RASTER_STYLES = ['satellite'];

function switchMapStyle(style) {
    if (style === window.currentMapStyle) return;

    const isSatellite = style === 'satellite';

    // Toggle the OSM standard base layer vs. the satellite raster layer —
    // exactly one is visible at a time.
    (state.baseStyleLayerIds || []).forEach(layerId => {
        if (state.map.getLayer(layerId)) {
            state.map.setLayoutProperty(layerId, 'visibility', isSatellite ? 'none' : 'visible');
        }
    });
    if (state.map.getLayer('tile-satellite')) {
        state.map.setLayoutProperty('tile-satellite', 'visibility', isSatellite ? 'visible' : 'none');
    }

    window.currentMapStyle = style;

    document.querySelectorAll('.map-style-btn[data-style]').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.style === style);
    });

    // Building footprint colors — Satellite keeps its red highlight treatment;
    // Default (OpenStreetMap) uses the normal look.
    if (state.map.getLayer('building-footprints-fill')) {
        state.map.setPaintProperty('building-footprints-fill', 'fill-color', isSatellite ? '#d9d0c9' : '#d9d0c9');
        state.map.setPaintProperty('building-footprints-fill', 'fill-opacity', isSatellite ? 1 : 1);
        state.map.setPaintProperty('building-footprints-outline', 'line-color', isSatellite ? '#af9e94' : '#af9e94');
        state.map.setPaintProperty('building-footprints-outline', 'line-width', isSatellite ? 1 : 1);
    }

    // Footprints stay visible on both styles now that Default is itself a
    // raster basemap — only their colors change between the two.
    setBuildingFootprintsVisibility(true);

    // 3D map: toggle satellite imagery vs. the OSM raster ground as whole
    // groups — same idea as the 2D map's baseStyleLayerIds handling.
    if (map3dState.map && map3dState.map.getLayer('tile-satellite-3d')) {
        (map3dState.baseStyleLayerIds || []).forEach(layerId => {
            if (map3dState.map.getLayer(layerId)) {
                map3dState.map.setLayoutProperty(layerId, 'visibility', isSatellite ? 'none' : 'visible');
            }
        });
        map3dState.map.setLayoutProperty('tile-satellite-3d', 'visibility', isSatellite ? 'visible' : 'none');
    }
}

// Shared visibility toggle for every building-footprint layer — static
// (predefined) and dynamic (added via the Admin Dashboard). Used by
// switchMapStyle() and by addDynamicBuildingFootprints2D() when it lazily
// creates the dynamic layers while Satellite View is already active.
function setBuildingFootprintsVisibility(visible) {
    if (!state.map) return;
    const visibility = visible ? 'visible' : 'none';
    [
        'building-footprints-fill',
        'building-footprints-outline',
        'dynamic-building-footprints-2d-fill',
        'dynamic-building-footprints-2d-outline'
    ].forEach(layerId => {
        if (state.map.getLayer(layerId)) {
            state.map.setLayoutProperty(layerId, 'visibility', visibility);
        }
    });
}


function createTextLabelIcon(shortName, type, offset = [0, 0, 0]) {
    const colors = {
        'administration': '#2c5aa0',
        'department': '#34a853',
        'facilities': '#FBBC04',
        'office': '#EA4335',
        'landmark': '#9C27B0',
    };

    const bgColor = colors[type] || '#757575';
    const rotation = offset[2] || 0;

    // Outer element — handed to maplibregl.Marker. MapLibre sets THIS element's
    // transform to position it on the map, so we must never touch it ourselves.
    const outer = document.createElement('div');

    // Inner element — safe to animate/rotate freely, MapLibre never touches this one.
    const inner = document.createElement('div');
    inner.style.cssText = `
        display: inline-block;
        background: ${bgColor};
        color: white;
        padding: 4px 5px;
        border-radius: 10px;
        font-weight: 700;
        font-size: 10px;
        font-family: 'Segoe UI', Arial, sans-serif;
        text-align: center;
        border: 2px solid white;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        white-space: nowrap;
        cursor: pointer;
        transform: rotate(${rotation}deg);
        transform-origin: center center;
        line-height: 1;
    `;
    inner.textContent = shortName;

    inner.addEventListener('mouseover', () => {
        inner.style.transform = `rotate(${rotation}deg) scale(1.15)`;
        inner.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
    });
    inner.addEventListener('mouseout', () => {
        inner.style.transform = `rotate(${rotation}deg) scale(1)`;
        inner.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
    });

    outer.appendChild(inner);

    return { element: outer, offset: [offset[0] || 0, offset[1] || 0] };
}
function buildLocationPopupHTML(location) {
    return `
        <div class="custom-popup-with-image" style="display: flex; gap: 15px; min-width: 400px; padding: 5px;">
            <div style="flex: 1; min-width: 200px;">
                <h3 style="margin: 0 0 8px 0; color: #2c5aa0; font-size: 16px; font-weight: 600; line-height: 1.3;">${location.name}</h3>
                <p style="margin: 5px 0; color: #666; font-size: 13px;">
                    <strong>Type:</strong> ${location.type.charAt(0).toUpperCase() + location.type.slice(1)}
                </p>
                ${location.rooms && location.rooms.length > 0 ?
                    `<button
                        onclick="RoomMarkerManager.toggle(${JSON.stringify(location).replace(/"/g, '&quot;')})"
                        style="width: 100%; padding: 10px; background: linear-gradient(135deg, #9c27b0 0%, #7b1fa2 100%); color: white; border: none; border-radius: 6px; cursor: pointer; margin-bottom: 8px; font-size: 14px; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 8px; transition: all 0.3s;"
                        onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 12px rgba(156, 39, 176, 0.4)'"
                        onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='none'"
                    >
                        <span style="font-size: 18px;">🚪</span>
                        <span>Show ${location.rooms.length} Room(s)</span>
                    </button>`
                    : ''}
                <button class="popup-btn" onclick="showLocationDetails(${JSON.stringify(location).replace(/"/g, '&quot;')})" style="width: 100%; padding: 10px; background: linear-gradient(135deg, #2c5aa0 0%, #1e3a6f 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; transition: all 0.3s; font-size: 14px;"
                    onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 12px rgba(44, 90, 160, 0.3)';"
                    onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='none';">
                    View Details
                </button>
            </div>
            ${location.image ? `
                <div style="flex-shrink: 0; width: 180px; height: 150px; border-radius: 8px; overflow: hidden; border: 2px solid #e0e0e0; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);">
                    <img src="${location.image}" alt="${location.name}" style="width: 100%; height: 100%; object-fit: cover; display: block;"
                        onerror="this.src='https://via.placeholder.com/180x150/cccccc/666666?text=No+Image';" />
                </div>
            ` : ''}
        </div>
    `;
}

function createLocationMarker(location) {
    const coords = normalizeCoords(location.coords);
    if (!coords) {
        console.error('Skipping location with invalid coords:', location.name);
        return null;
    }

    const { element, offset } = createTextLabelIcon(
        location.shortName || location.name.substring(0, 4).toUpperCase(),
        location.type,
        location.labelOffset || [0, 0, 0]
    );

    const popup = new maplibregl.Popup({ maxWidth: 'min(480px, calc(100vw - 32px))', className: 'building-popup-with-image' })
        .setHTML(buildLocationPopupHTML(location));

    const marker = new maplibregl.Marker({ element, offset })
        .setLngLat([coords[1], coords[0]])
        .setPopup(popup)
        .addTo(state.map);

    return marker;
}

function addMarkers() {
    state.markers.forEach(marker => marker.remove());
    state.markers = [];

    const campus = campusData[state.currentCampus];
    const session = getAuthSession();
    const role = session?.role || 'VISITOR';

    campus.locations.forEach(location => {
        if (!Permissions.canAccessLocationType(role, location.type)) return;
        if (state.currentFilter !== 'all' && location.type !== state.currentFilter) return;

        const marker = createLocationMarker(location);
        if (marker) state.markers.push(marker);
    });

    console.log(`Added ${state.markers.length} markers to map`);
}

function updateMarkers() {
    state.markers.forEach(marker => marker.remove());
    state.markers = [];

    RoomMarkerManager.clear();

    const campus = campusData[state.currentCampus];
    const session = getAuthSession();
    const role = session?.role || 'VISITOR';

    campus.locations.forEach(location => {
        if (!Permissions.canAccessLocationType(role, location.type)) return;
        if (state.currentFilter !== 'all' && location.type !== state.currentFilter) return;

        const marker = createLocationMarker(location);
        if (marker) state.markers.push(marker);
    });

    const filteredCount = state.markers.length;
    const filterName = state.currentFilter === 'all' ? 'All locations' : state.currentFilter.charAt(0).toUpperCase() + state.currentFilter.slice(1);
    showNotification(`Showing ${filteredCount} ${filterName}`, 'info');
}





// Global functions for popup buttons
window.navigateToLocation = function(locationId) {
    const campus = campusData[state.currentCampus];
    const location = campus.locations.find(loc => loc.id === locationId);
    if (location) {
        state.selectedLocation = location;
        navigateToSelected();
    }
};

window.viewDetails = function(locationId) {
    const campus = campusData[state.currentCampus];
    const location = campus.locations.find(loc => loc.id === locationId);
    if (location) {
        showLocationDetails(location);
    }
};

// Enhanced Search Functionality - FIXED
function handleSearch() {
    const query = document.getElementById('searchInput').value.toLowerCase().trim();
    const resultsDiv = document.getElementById('searchResults');
    
    if (!query) {
        resultsDiv.classList.add('hidden');
        return;
    }
    
    const campus = campusData[state.currentCampus];
    const session = getAuthSession();
    const role = session?.role || 'VISITOR';
    const results = [];
    
    campus.locations.forEach(building => {
        if (!Permissions.canAccessLocationType(role, building.type)) return;
        // Search building names and short names
        if (building.name.toLowerCase().includes(query) ||
            (building.shortName && building.shortName.toLowerCase().includes(query))) {
            results.push({ 
                ...building, 
                matchType: 'building',
                displayName: building.name,
                subtitle: building.type
            });
        }
        // Search room names - FIX: Check if rooms exist and is array
        if (building.rooms && Array.isArray(building.rooms) && building.rooms.length > 0) {
            building.rooms.forEach(room => {
                // FIX: Check if room.name exists before searching
                if (room.name && room.name.toLowerCase().includes(query)) {
                    results.push({ 
                        ...room,
                        buildingName: building.name,
                        buildingId: building.id,
                        matchType: 'room',
                        displayName: room.name,
                        subtitle: `${building.name} - ${room.floor}`
                    });
                }
            });
        }
    });
    
    console.log(`Search query: "${query}" - Found ${results.length} results`);
    displaySearchResults(results);
}

function calculateDistance(coord1, coord2) {
    const R = 6371000;
    const lat1 = coord1[0] * Math.PI / 180;
    const lat2 = coord2[0] * Math.PI / 180;
    const dLat = (coord2[0] - coord1[0]) * Math.PI / 180;
    const dLng = (coord2[1] - coord1[1]) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ✅ Bearing (0–360, clockwise from north) from coord1 to coord2 — used as a
// derived-heading fallback for dead reckoning when pos.coords.heading is
// null (common on many Android devices even while actively walking).
function calculateBearing(coord1, coord2) {
    const lat1 = coord1[0] * Math.PI / 180;
    const lat2 = coord2[0] * Math.PI / 180;
    const dLng = (coord2[1] - coord1[1]) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ✅ Finds the closest point on the ENTIRE route polyline (not just its
// first coordinate) to a given lat/lng — used both to snap the dot onto
// the path and to measure a short, stable "off-path" gap instead of a
// gap that grows forever as you walk further from the route's start.
function nearestPointOnPolyline(lat, lng, routeCoordinates) {
    if (!routeCoordinates || routeCoordinates.length === 0) return null;
    if (routeCoordinates.length === 1) {
        const only = routeCoordinates[0];
        return { lat: only.lat, lng: only.lng, distanceMeters: calculateDistance([lat, lng], [only.lat, only.lng]) };
    }

    const latRad = lat * Math.PI / 180;
    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos(latRad);

    let best = null;

    for (let i = 0; i < routeCoordinates.length - 1; i++) {
        const a = routeCoordinates[i];
        const b = routeCoordinates[i + 1];

        const bx = (b.lng - a.lng) * metersPerDegLng;
        const by = (b.lat - a.lat) * metersPerDegLat;
        const px = (lng - a.lng) * metersPerDegLng;
        const py = (lat - a.lat) * metersPerDegLat;

        const segLenSq = bx * bx + by * by;
        let t = segLenSq > 0 ? ((px * bx + py * by) / segLenSq) : 0;
        t = Math.max(0, Math.min(1, t));

        const projLng = a.lng + ((t * bx) / metersPerDegLng);
        const projLat = a.lat + ((t * by) / metersPerDegLat);

        const dist = calculateDistance([lat, lng], [projLat, projLng]);

        if (!best || dist < best.distanceMeters) {
            best = { lat: projLat, lng: projLng, distanceMeters: dist };
        }
    }

    return best;
}

function displaySearchResults(results) {
    const resultsDiv = document.getElementById('searchResults');
    resultsDiv.innerHTML = '';

        // In displaySearchResults(), add this after getting results:
    const MAX_RESULTS = 50; // Show only first 50 results
    const displayResults = results.slice(0, MAX_RESULTS);

    if (results.length > MAX_RESULTS) {
        // Show message that there are more results
        const moreMsg = document.createElement('div');
        moreMsg.style.cssText = 'padding: 10px; text-align: center; color: #666; font-size: 12px; border-top: 1px solid #e0e0e0;';
        moreMsg.textContent = `Showing ${MAX_RESULTS} of ${results.length} results. Be more specific to narrow down.`;
        resultsDiv.appendChild(moreMsg);
    }
    
    if (results.length === 0) {
        resultsDiv.innerHTML = '<div class="search-result-item">No results found</div>';
        resultsDiv.classList.remove('hidden');
        return;
    }
    
    // Add result count header
    const countHeader = document.createElement('div');
    countHeader.style.cssText = 'padding: 10px 15px; background: #f0f7ff; color: #2c5aa0; font-weight: 600; font-size: 13px; border-bottom: 2px solid #2c5aa0; position: sticky; top: 0; z-index: 10;';
    countHeader.textContent = `${results.length} Result${results.length > 1 ? 's' : ''} Found`;
    resultsDiv.appendChild(countHeader);
    
    results.forEach(result => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        
        const icon = result.matchType === 'building' ? '🏢' : '🚪';
        
        item.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px;">
                <span style="font-size: 24px;">${icon}</span>
                <div style="flex: 1;">
                    <div class="result-name">${result.displayName}</div>
                    <div class="result-type" style="font-size: 12px; color: #666;">
                        ${result.subtitle}
                    </div>
                    ${result.matchType === 'room' && result.instructor ? `
                    <div style="font-size: 12px; color: #9c27b0; margin-top: 2px;">
                        👨‍🏫 ${result.instructor}
                    </div>` : ''}
                </div>
            </div>
        `;
        
        item.addEventListener('click', () => {
            if (result.matchType === 'building') {
                // FIX: Handle both array [lat, lng] and object {lat, lng} formats
                let coords;
                if (Array.isArray(result.coords)) {
                    coords = result.coords; // Already array format
                } else if (result.coords && result.coords.lat && result.coords.lng) {
                    coords = [result.coords.lat, result.coords.lng]; // Convert object to array
                } else {
                    console.error('Invalid coords format:', result.coords);
                    showNotification('Error: Invalid location coordinates', 'error');
                    return;
                }
                
                // Show popup and zoom to building
                state.map.jumpTo({ center: [coords[1], coords[0]], zoom: 19 });
                
                // Find the marker and open its popup
                const marker = state.markers.find(m => {
                    const lngLat = m.getLngLat();
                    return Math.abs(lngLat.lat - coords[0]) < 0.00001 &&
                        Math.abs(lngLat.lng - coords[1]) < 0.00001;
                });
                
                if (marker) {
                    openMarkerPopup(marker);
                }
            } else {
                showRoomDetails(result);
                state.map.jumpTo({ center: [result.coords[1], result.coords[0]], zoom: 20 });
            }
            resultsDiv.classList.add('hidden');
        });
        resultsDiv.appendChild(item);
    });
    
    resultsDiv.classList.remove('hidden');
}

function showLocationDetails(location) {
    state.selectedLocation = location;
    
    const modal = document.getElementById('locationModal');
    document.getElementById('locationTitle').textContent = location.name;
    
    let roomsList = '';
    if (Array.isArray(location.rooms) && location.rooms.length > 0) {
        if (typeof location.rooms[0] === 'object') {
            roomsList = `
                <p><strong>Available Rooms:</strong></p>
                <div style="max-height: 300px; overflow-y: auto;">
                    ${location.rooms.map(room => `
                    <div class="room-item" onclick="state._routeRecordedThisNav = false; navigateToRoom(${room.id}, ${location.id})" style="
                            padding: 12px;
                            margin: 8px 0;
                            background: #f8faf8;
                            border-radius: 8px;
                            cursor: pointer;
                            border-left: 4px solid #2c5aa0;
                            transition: all 0.3s;
                        " onmouseover="this.style.background='#e9ecef'; this.style.transform='translateX(5px)'" 
                        onmouseout="this.style.background='#f8f9fa'; this.style.transform='translateX(0)'">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <strong>🚪 ${room.name}</strong>
                                    <div style="font-size: 12px; color: #666; margin-top: 4px;">
                                        ${room.floor}
                                    </div>
                                </div>
                                <span style="color: #000000ff;">→ Go</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        } else {
            roomsList = `
                <p><strong>Available Rooms:</strong></p>
                <ul>
                    ${location.rooms.map(room => `<li>${room}</li>`).join('')}
                </ul>
            `;
        }
    }

    // ✅ Virtual Tour button — only shows for buildings with tourPhotos
    const tourBtn = location.tourPhotos && location.tourPhotos.length > 0
        ? `<button onclick="openVirtualTour('${location.name}')" style="
            width: 100%;
            margin-top: 8px;
            padding: 10px;
            background: linear-gradient(135deg, #2c5aa0, #6c63ff);
            color: white;
            border: none;
            border-radius: 10px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        ">🏛️ Virtual Tour</button>`
        : '';
    
    const details = `
        <p><strong>Type:</strong> ${location.type.charAt(0).toUpperCase() + location.type.slice(1)}</p>
        ${location.description ? `<p><strong>Description:</strong> ${location.description}</p>` : ''}
        ${roomsList}
        ${tourBtn}
    `;
    
    document.getElementById('locationDetails').innerHTML = details;

    // Swap the primary button's label depending on whether you're already
    // mid-navigation — "Navigate Here" would restart the trip, so offer to
    // queue this as the next stop instead.
    const navigateBtn = document.getElementById('navigateBtn');
    if (navigateBtn) {
        navigateBtn.innerHTML = state.multiStop.active
            ? '<span>➕</span> Add as Next Stop'
            : '<span>🧭</span> Navigate Here';
    }

    modal.classList.add('active');
}

function openVirtualTour(buildingName) {
    const campus = campusData[state.currentCampus];
    const building = campus.locations.find(l => l.name === buildingName);
    if (!building || !building.tourPhotos) return;

    const existing = document.getElementById('virtualTourModal');
    if (existing) existing.remove();

    const floors = building.tourPhotos;

    const modal = document.createElement('div');
    modal.id = 'virtualTourModal';
    modal.className = 'virtual-tour-modal';
    modal.dataset.building = buildingName;
    modal.dataset.floorIndex = '0';
    modal.dataset.spotIndex = '0';
    modal.style.cssText = `
        position: fixed;
        top: 0; left: 0;
        width: 100%; height: 100%;
        background: rgba(0,0,0,0.97);
        z-index: 99999;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
    `;

    modal.innerHTML = `
        <div class="virtual-tour-shell">

            <!-- Header -->
            <div class="virtual-tour-header">
                <h2 class="virtual-tour-title">🏛️ ${buildingName} — Virtual Tour</h2>
                <button class="virtual-tour-exit-btn" type="button">Exit Tour</button>
            </div>

            <!-- Floor Tabs -->
            <div id="floorTabs" style="display:flex; gap:10px; margin-bottom:16px; flex-wrap:wrap;">
                ${floors.map((f, i) => `
                    <button onclick="switchFloor(${i})" id="floorTab_${i}" style="
                        padding: 8px 20px;
                        border-radius: 20px;
                        border: 2px solid ${i === 0 ? '#6c63ff' : 'rgba(255,255,255,0.3)'};
                        background: ${i === 0 ? '#6c63ff' : 'transparent'};
                        color: white;
                        font-weight: 600;
                        font-size: 13px;
                        cursor: pointer;
                        transition: all 0.2s;
                    ">${f.floor}</button>
                `).join('')}
            </div>

            <!-- Panorama Wrapper -->
            <div class="virtual-tour-panorama" style="position: relative; width: 100%; border-radius: 12px; overflow: hidden; background: #111;">

                <button class="virtual-tour-exit-fab" type="button" aria-label="Exit virtual tour">Exit</button>

                <!-- Fade overlay for transitions -->
                <div id="tourFade" style="
                    position: absolute;
                    inset: 0;
                    background: black;
                    opacity: 0;
                    z-index: 5;
                    pointer-events: none;
                    transition: opacity 0.35s ease;
                    border-radius: 12px;
                "></div>

                <!-- Pannellum container -->
                <div id="panoramaContainer" style="
                    width: 100%;
                    height: 100%;
                    border-radius: 12px;
                "></div>

                <!-- Back Arrow -->
                <div id="arrowBack" onclick="moveSpot(-1)" style="
                    position: absolute;
                    left: 50%;
                    bottom: 80px;
                    transform: translateX(-50%) translateX(-60px) rotate(270deg);
                    width: 64px;
                    height: 64px;
                    border-radius: 50%;
                    background: rgba(255,255,255,0.25);
                    backdrop-filter: blur(4px);
                    cursor: pointer;
                    z-index: 10;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: background 0.2s, transform 0.2s, opacity 0.3s;
                    border: 2px solid rgba(255,255,255,0.4);
                " onmouseover="this.style.background='rgba(255,255,255,0.45)'"
                onmouseout="this.style.background='rgba(255,255,255,0.25)'">
                    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                        <polyline points="7,18 14,10 21,18" stroke="white" stroke-width="3.5"
                            stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </div>

                <!-- Forward Arrow -->
                <div id="arrowForward" onclick="moveSpot(1)" style="
                    position: absolute;
                    left: 50%;
                    bottom: 80px;
                    transform: translateX(-50%) translateX(60px);
                    width: 64px;
                    height: 64px;
                    border-radius: 50%;
                    background: rgba(255,255,255,0.25);
                    backdrop-filter: blur(4px);
                    cursor: pointer;
                    z-index: 10;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: background 0.2s, transform 0.2s, opacity 0.3s;
                    border: 2px solid rgba(255,255,255,0.4);
                " onmouseover="this.style.background='rgba(255,255,255,0.45)'"
                    onmouseout="this.style.background='rgba(255,255,255,0.25)'">
                    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                        <polyline points="7,18 14,10 21,18" stroke="white" stroke-width="3.5"
                            stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </div>

                <!-- Dot Indicator (bottom right) -->
                <div id="miniMap" style="
                    position: absolute;
                    bottom: 16px;
                    right: 16px;
                    background: rgba(0,0,0,0.65);
                    border: 2px solid rgba(255,255,255,0.3);
                    border-radius: 12px;
                    padding: 10px 14px;
                    z-index: 10;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 8px;
                    min-width: 120px;
                ">
                    <!-- Floor label -->
                    <div id="miniMapLabel" style="
                        color: rgba(255,255,255,0.6);
                        font-size: 11px;
                        font-weight: 600;
                        letter-spacing: 0.5px;
                        text-transform: uppercase;
                    ">${floors[0].floor}</div>

                    <!-- Dot trail -->
                    <div id="miniMapDots" style="
                        display: flex;
                        gap: 6px;
                        align-items: center;
                        justify-content: center;
                        flex-wrap: wrap;
                        max-width: 100px;
                    ">
                        ${floors[0].spots.map((s, i) => `
                            <div id="miniDot_${i}" title="${s.label}" style="
                                width: ${i === 0 ? '12px' : '8px'};
                                height: ${i === 0 ? '12px' : '8px'};
                                border-radius: 50%;
                                background: ${i === 0 ? '#6c63ff' : 'rgba(255,255,255,0.25)'};
                                border: ${i === 0 ? '2px solid white' : '1px solid rgba(255,255,255,0.3)'};
                                transition: all 0.3s ease;
                                cursor: pointer;
                                box-shadow: ${i === 0 ? '0 0 0 4px rgba(108,99,255,0.3)' : 'none'};
                            " onclick="goToSpot(${i})"></div>
                        `).join('')}
                    </div>

                    <!-- Current spot name -->
                    <div id="miniMapSpotName" style="
                        color: white;
                        font-size: 11px;
                        font-weight: 500;
                        text-align: center;
                        max-width: 100px;
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                    ">${floors[0].spots[0].label}</div>
                </div>

            </div>

            <!-- Spot label + dots -->
            <div style="display:flex; justify-content:center; align-items:center; gap:16px; margin-top:10px;">
                <p id="spotLabel" style="color:rgba(255,255,255,0.7); font-size:13px; margin:0;">
                    📍 <strong style="color:white;">${floors[0].spots[0].label}</strong>
                </p>
                <p id="spotCounter" style="color:rgba(255,255,255,0.4); font-size:12px; margin:0;">
                    1 / ${floors[0].spots.length}
                </p>
            </div>

            <!-- Dot indicators -->
            <div id="spotDots" style="display:flex; justify-content:center; gap:8px; margin-top:8px;">
                ${floors[0].spots.map((_, i) => `
                    <div id="dot_${i}" onclick="goToSpot(${i})" style="
                        width: 8px; height: 8px;
                        border-radius: 50%;
                        background: ${i === 0 ? '#6c63ff' : 'rgba(255,255,255,0.3)'};
                        cursor: pointer;
                        transition: background 0.2s;
                    "></div>
                `).join('')}
            </div>

        </div>
    `;

    document.body.appendChild(modal);

    const exitButtons = modal.querySelectorAll('.virtual-tour-exit-btn, .virtual-tour-exit-fab');
    exitButtons.forEach(btn => btn.addEventListener('click', closeVirtualTour));

    modal.addEventListener('click', e => {
        if (e.target === modal) closeVirtualTour();
    });

    document._tourKeyHandler = e => {
        if (e.key === 'ArrowRight') moveSpot(1);
        if (e.key === 'ArrowLeft')  moveSpot(-1);
        if (e.key === 'Escape')     closeVirtualTour();
    };
    document.addEventListener('keydown', document._tourKeyHandler);

    loadPanorama(floors[0].spots[0].src, false);
    updateArrows(0, floors[0].spots.length);
}

function updateMiniMap(floorIndex, spotIndex, building) {
    const floor = building.tourPhotos[floorIndex];
    const spot = floor.spots[spotIndex];

    const label = document.getElementById('miniMapLabel');
    if (label) label.textContent = floor.floor;

    const spotName = document.getElementById('miniMapSpotName');
    if (spotName) spotName.textContent = spot.label;

    const dotsContainer = document.getElementById('miniMapDots');
    if (dotsContainer) {
        dotsContainer.innerHTML = floor.spots.map((s, i) => `
            <div id="miniDot_${i}" title="${s.label}" style="
                width: ${i === spotIndex ? '12px' : '8px'};
                height: ${i === spotIndex ? '12px' : '8px'};
                border-radius: 50%;
                background: ${i === spotIndex ? '#6c63ff' : 'rgba(255,255,255,0.25)'};
                border: ${i === spotIndex ? '2px solid white' : '1px solid rgba(255,255,255,0.3)'};
                transition: all 0.3s ease;
                cursor: pointer;
                box-shadow: ${i === spotIndex ? '0 0 0 4px rgba(108,99,255,0.3)' : 'none'};
            " onclick="goToSpot(${i})"></div>
        `).join('');
    }
}

function loadPanorama(src, fade = true) {
    const fadeEl = document.getElementById('tourFade');

    const doLoad = () => {
        if (window.pannellumViewer) {
            window.pannellumViewer.destroy();
            window.pannellumViewer = null;
        }
        window.pannellumViewer = pannellum.viewer('panoramaContainer', {
            type: 'equirectangular',
            panorama: src,
            autoLoad: true,
            autoRotate: 0,
            compass: false,
            showFullscreenCtrl: false,
            showZoomCtrl: false,
            mouseZoom: true,
            hfov: 90,
            minHfov: 50,
            maxHfov: 110,
            pitch: 0,
            minPitch: -20,
            maxPitch: 20,
            strings: { loadingLabel: "Loading..." }
        });

        // Fade back in after photo loads
        window.pannellumViewer.on('load', () => {
            if (fadeEl) fadeEl.style.opacity = '0';
        });
    };

    if (fade && fadeEl) {
        fadeEl.style.opacity = '1';
        setTimeout(doLoad, 350);
    } else {
        doLoad();
    }
}

function moveSpot(direction) {
    const modal = document.getElementById('virtualTourModal');
    if (!modal) return;

    const campus = campusData[state.currentCampus];
    const building = campus.locations.find(l => l.name === modal.dataset.building);
    if (!building) return;

    const floorIndex = parseInt(modal.dataset.floorIndex);
    let spotIndex = parseInt(modal.dataset.spotIndex);
    const spots = building.tourPhotos[floorIndex].spots;

    spotIndex += direction;
    if (spotIndex < 0 || spotIndex >= spots.length) return;

    modal.dataset.spotIndex = spotIndex;
    loadPanorama(spots[spotIndex].src, true);
    updateSpotUI(floorIndex, spotIndex, building);
}

function goToSpot(index) {
    const modal = document.getElementById('virtualTourModal');
    if (!modal) return;

    const campus = campusData[state.currentCampus];
    const building = campus.locations.find(l => l.name === modal.dataset.building);
    if (!building) return;

    const floorIndex = parseInt(modal.dataset.floorIndex);
    const spots = building.tourPhotos[floorIndex].spots;

    modal.dataset.spotIndex = index;
    loadPanorama(spots[index].src, true);
    updateSpotUI(floorIndex, index, building);
}

function switchFloor(floorIndex) {
    const modal = document.getElementById('virtualTourModal');
    if (!modal) return;

    const campus = campusData[state.currentCampus];
    const building = campus.locations.find(l => l.name === modal.dataset.building);
    if (!building) return;

    modal.dataset.floorIndex = floorIndex;
    modal.dataset.spotIndex = '0';

    const floors = building.tourPhotos;
    const spots = floors[floorIndex].spots;

    // Update floor tabs
    floors.forEach((_, i) => {
        const tab = document.getElementById(`floorTab_${i}`);
        tab.style.background = i === floorIndex ? '#6c63ff' : 'transparent';
        tab.style.borderColor = i === floorIndex ? '#6c63ff' : 'rgba(255,255,255,0.3)';
    });

    // Rebuild dots
    const dotsContainer = document.getElementById('spotDots');
    dotsContainer.innerHTML = spots.map((_, i) => `
        <div id="dot_${i}" onclick="goToSpot(${i})" style="
            width: 8px; height: 8px;
            border-radius: 50%;
            background: ${i === 0 ? '#6c63ff' : 'rgba(255,255,255,0.3)'};
            cursor: pointer;
            transition: background 0.2s;
        "></div>
    `).join('');

    loadPanorama(spots[0].src, true);
    updateSpotUI(floorIndex, 0, building);
}

function updateSpotUI(floorIndex, spotIndex, building) {
    const spots = building.tourPhotos[floorIndex].spots;

    const label = document.getElementById('spotLabel');
    const counter = document.getElementById('spotCounter');
    if (label) label.innerHTML = `📍 <strong style="color:white;">${spots[spotIndex].label}</strong>`;
    if (counter) counter.textContent = `${spotIndex + 1} / ${spots.length}`;

    spots.forEach((_, i) => {
        const dot = document.getElementById(`dot_${i}`);
        if (dot) dot.style.background = i === spotIndex ? '#6c63ff' : 'rgba(255,255,255,0.3)';
    });

    updateArrows(spotIndex, spots.length);
    updateMiniMap(floorIndex, spotIndex, building);
}
function updateArrows(spotIndex, total) {
    const back    = document.getElementById('arrowBack');
    const forward = document.getElementById('arrowForward');
    if (back) {
        back.style.opacity = spotIndex === 0 ? '0.3' : '1';
        back.style.cursor  = spotIndex === 0 ? 'not-allowed' : 'pointer';
    }
    if (forward) {
        forward.style.opacity = spotIndex >= total - 1 ? '0.3' : '1';
        forward.style.cursor  = spotIndex >= total - 1 ? 'not-allowed' : 'pointer';
    }
}

function closeVirtualTour() {
    if (window.pannellumViewer) {
        window.pannellumViewer.destroy();
        window.pannellumViewer = null;
    }
    if (document._tourKeyHandler) {
        document.removeEventListener('keydown', document._tourKeyHandler);
        document._tourKeyHandler = null;
    }
    const modal = document.getElementById('virtualTourModal');
    if (modal) modal.remove();
}

// Global function to navigate to a specific room
window.navigateToRoom = function(roomId, buildingId) {
    const campus = campusData[state.currentCampus];
    const building = campus.locations.find(loc => loc.id === buildingId);
    
    if (building) {
        const room = building.rooms.find(r => r.id === roomId);
        if (room) {
            const roomLocation = {
                ...room,
                id: `room_${building.id}_${room.id}`,
                name: room.name,
                coords: room.coords,
                matchType: 'room',
                buildingName: building.name
            };
            
            state.selectedLocation = roomLocation;
            state.lastRoomBuilding = building;
            state._routeRecordedThisNav = false; // ✅ Reset so room gets recorded
            document.getElementById('locationModal').classList.remove('active');
            closeActivePopup();
            RoomMarkerManager.clear();

            // Respect an in-progress multi-stop trip instead of always
            // hijacking navigation — queue the room instead of restarting.
            if (state.multiStop.active) {
                msAddLocationAsStop(roomLocation);
            } else {
                navigateToSelected();
            }
            
            state.map.jumpTo({ center: [room.coords[1], room.coords[0]], zoom: 20 });
        }
    }
};

// Show Room Details
function showRoomDetails(room) {
    state.selectedLocation = room;
    
    const modal = document.getElementById('locationModal');
    document.getElementById('locationTitle').textContent = room.name;
    
    const details = `
        <p><strong>Building:</strong> ${room.buildingName}</p>
        <p><strong>Floor:</strong> ${room.floor}</p>
        <p><strong>Type:</strong> ${room.type}</p>
        <p><strong>Capacity:</strong> ${room.capacity} persons</p>
        <div style="margin-top: 15px; padding: 10px; background: #f0f7ff; border-radius: 8px; border-left: 4px solid #2c5aa0;">
            <strong>📍 Location:</strong> ${room.buildingName}, ${room.floor}
        </div>
    `;
    
    document.getElementById('locationDetails').innerHTML = details;

    // Swap the primary button's label depending on whether you're already
    // mid-navigation — "Navigate Here" would restart the trip, so offer to
    // queue this as the next stop instead.
    const navigateBtn = document.getElementById('navigateBtn');
    if (navigateBtn) {
        navigateBtn.innerHTML = state.multiStop.active
            ? '<span>➕</span> Add as Next Stop'
            : '<span>🧭</span> Navigate Here';
    }

    modal.classList.add('active');
}

// Calls our own /api/route endpoint, which proxies to OpenRouteService —
// keeps the ORS API key server-side, out of client JS.
async function fetchORSRoute(startCoords, destCoords, profile = 'foot', _isRetry = false) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let response, data;
    try {
        response = await fetch('/api/route', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                coordinates: [
                    [startCoords[1], startCoords[0]],
                    [destCoords[1], destCoords[0]]
                ],
                profile
            }),
            signal: controller.signal
        });
        data = await response.json();
    } catch (err) {
        clearTimeout(timeoutId);
        if (!_isRetry) {
            return fetchORSRoute(startCoords, destCoords, profile, true);
        }
        throw new Error('ORS request failed or timed out');
    }
    clearTimeout(timeoutId);

    if (!data.ok || !data.route?.features?.length) {
        throw new Error(data.error || 'No route found');
    }

    const feature = data.route.features[0];
    const coordinates = feature.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));

    const instructions = [];
    (feature.properties.segments || []).forEach(segment => {
        (segment.steps || []).forEach(step => {
            // ✅ ADD — the coordinate where this maneuver actually happens
            // (way_points[0] is this step's start index into the geometry
            // array). Nothing currently reads this except voice-navigation.js,
            // which needs it to know how far the user is from the NEXT turn —
            // 'distance' alone only says how long the step itself is.
            const wp = Array.isArray(step.way_points) ? step.way_points[0] : null;
            const stepLocation = (wp != null && coordinates[wp]) ? coordinates[wp] : null;

            instructions.push({
                type: mapORSManeuverToType(step.type),
                road: step.name,
                distance: step.distance,
                location: stepLocation
            });
        });
    });

    return {
        coordinates,
        summary: {
            totalDistance: feature.properties.summary.distance,
            totalTime: feature.properties.summary.duration
        },
        instructions
    };
}

// Translates ORS's numeric maneuver codes into the same 'turn-left' / 'turn-right' /
// etc. type strings getDirectionIcon() already expects, so showCustomRouteInfo()
// needs zero changes.
function mapORSManeuverToType(type) {
    const typeMap = {
        0: 'turn-left',
        1: 'turn-right',
        2: 'turn-sharp-left',
        3: 'turn-sharp-right',
        4: 'turn-slight-left',
        5: 'turn-slight-right',
        6: 'straight',
        7: 'roundabout',
        8: 'roundabout',
        9: 'uturn',
        10: 'arrive',
        11: 'depart',
        12: 'turn-slight-left',
        13: 'turn-slight-right'
    };
    return typeMap[type] ?? 'continue';
}

// Walk-only build: Car/Bike buttons were removed, so every route — single-
// stop AND multi-stop — always resolves to the walking profile regardless
// of state.travelMode or distance from campus.
function pickRoutingProfile(startCoords, destCoords) {
    return 'foot';
}

// Label/icon for whichever profile a route was actually calculated with
// (not just state.travelMode, since 'auto' resolves differently per leg).
function getTravelModeLabel(profile) {
    const labels = {
        'foot': { label: 'Estimated Walking Time', icon: '⏱️' },
        'driving-car': { label: 'Estimated Driving Time', icon: '🚗' },
        'cycling-regular': { label: 'Estimated Cycling Time', icon: '🚴' }
    };
    return labels[profile] || labels['foot'];
}

// ✅ Monotonically increasing token — lets refreshActiveRouteForModeChange
// detect and discard STALE responses when the user switches travel modes
// again before the previous request finishes. Without this, rapid
// Walk→Car→Bike switching could let an older, slower response (success OR
// failure) land last and silently overwrite the correct, newer route —
// which is what made the Route Details section appear stuck or show a
// mismatched error after switching modes several times.
let routeRequestSeq = 0;

// Recalculates the currently displayed route for the SAME destination after
// a travel-mode switch — lighter than navigateToSelected() since it skips
// modal-closing, location-watch restart, and route-history recording.
async function refreshActiveRouteForModeChange() {
    const myRequestId = ++routeRequestSeq;

    const destination = state.currentRoute.destination;
    const startCoords = state.userLocation
        ? [state.userLocation.lat, state.userLocation.lng]
        : [campusData[state.currentCampus].center.lat, campusData[state.currentCampus].center.lng];

    const routeColor = state.isRoomNavigation ? '#9c27b0' : '#2c5aa0';
    const routingProfile = pickRoutingProfile(startCoords, destination.coords);

    showNotification('Recalculating route...', 'info');

    try {
        const route = await fetchORSRoute(startCoords, destination.coords, routingProfile);

        // A newer mode switch happened while this request was still in
        // flight — this response is stale, discard it without touching
        // state, the map, or the Route Details panel.
        if (myRequestId !== routeRequestSeq) return;

        state.currentRoute = {
            coordinates: route.coordinates,
            distance: route.summary.totalDistance,
            duration: route.summary.totalTime,
            instructions: route.instructions,
            profile: routingProfile,
            destination: destination
        };

        // ✅ ADD — new instructions for the new mode, so voice guidance
        // resets to the first upcoming turn instead of speaking stale ones.
        document.dispatchEvent(new CustomEvent('navRouteStarted', { detail: { route: state.currentRoute } }));

        drawRouteLine(route.coordinates, routeColor);
        addAnimatedOverlay(route.coordinates);
        addEndDottedLine(route.coordinates, destination);
        addStartDottedLine(startCoords, route.coordinates);

        if (map3dState.active && map3dState.map) {
            sync3DRoute();
        }

        showCustomRouteInfo(route, destination, routingProfile);
    } catch (err) {
        // Same staleness check on the failure path — an old, abandoned
        // request's error must not surface after the user has already
        // moved on to (and possibly successfully loaded) a different mode.
        if (myRequestId !== routeRequestSeq) return;

        showNotification('Could not recalculate route for this travel mode. Try a different mode.', 'error');
        drawFallbackRoute(startCoords, destination, routingProfile);
    }
}

// Draws (or updates) the main route as a MapLibre GeoJSON line layer.
function drawRouteLine(coordinates, color) {
    const geojson = {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: coordinates.map(c => [c.lng, c.lat])
        }
    };

    if (!state.map.getSource('route-line')) {
        state.map.addSource('route-line', { type: 'geojson', data: geojson });
        state.map.addLayer({
            id: 'route-line-layer',
            type: 'line',
            source: 'route-line',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': color, 'line-width': 6, 'line-opacity': 0.8 }
        });
    } else {
        state.map.getSource('route-line').setData(geojson);
        state.map.setPaintProperty('route-line-layer', 'line-color', color);
    }

    const lngs = geojson.geometry.coordinates.map(c => c[0]);
    const lats = geojson.geometry.coordinates.map(c => c[1]);
    state.map.fitBounds(
        [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
        { padding: 80, maxZoom: 18 }
    );
}

// Removes all route-related layers/sources (main line, dashed overlay,
// end dotted line, fallback route) and stops the marching-ants animation.
function removeRouteLine() {
    if (state.routeAnimation) {
        clearInterval(state.routeAnimation);
        state.routeAnimation = null;
    }
    // ✅ addAnimatedOverlay() now drives the dash via requestAnimationFrame
    // (to match the 3D route's timing) instead of setInterval — cancel that
    // loop too, or it keeps ticking (harmlessly self-terminating next frame
    // once it notices the layer is gone, but no reason to wait for that).
    if (state.dashAnimationFrame) {
        cancelAnimationFrame(state.dashAnimationFrame);
        state.dashAnimationFrame = null;
    }
    state.dashStep = -1;

    const layers = ['route-line-layer', 'dashed-overlay-layer', 'end-dotted-line-layer', 'start-dotted-line-layer', 'fallback-route-line-layer'];
    const sources = ['route-line', 'dashed-overlay', 'end-dotted-line', 'start-dotted-line', 'fallback-route-line'];

    layers.forEach(id => {
        if (state.map.getLayer(id)) state.map.removeLayer(id);
    });
    sources.forEach(id => {
        if (state.map.getSource(id)) state.map.removeSource(id);
    });
}


// Enhanced Navigation with Color Differentiation
// Enhanced Navigation with Color Differentiation
// The location modal's primary button does double duty: normal
// "Navigate Here" when nothing is active, or "Add as Next Stop" once a
// multi-stop trip is already underway — starting a brand-new route here
// would abandon whatever you're currently walking to.
function handlePrimaryLocationAction() {
    if (state.multiStop.active) {
        msAddLocationAsStop(state.selectedLocation);
    } else {
        navigateToSelected();
    }
}

async function navigateToSelected() {
    if (!state.selectedLocation) return;

    // Visitors must state a purpose first (visitor-purpose.js). Cancelling
    // leaves the current map/route exactly as it was.
    if (typeof window.ensureVisitPurpose === 'function') {
        const allowed = await window.ensureVisitPurpose(state.selectedLocation);
        if (!allowed) return;
    }
    
    // Clear existing route
    clearRoute();

    // Hide popups/panels so only route details remain
    closeActivePopup();
    document.getElementById('locationModal')?.classList.remove('active');
    const buildingPanel = document.getElementById('buildingImagePanel');
    if (buildingPanel) {
        buildingPanel.style.display = 'none';
        buildingPanel.setAttribute('aria-hidden', 'true');
    }
    const searchResults = document.getElementById('searchResults');
    if (searchResults) searchResults.classList.add('hidden');
    // ✅ Close the sidebar drawer and AI chat widget too — same pattern
    // setSidebarState() already uses when a different overlay opens — so
    // navigating doesn't leave another tab/panel open behind the route card.
    window.closeSidebarPanel?.();
    window.AIChatWidget?.close?.();
    
    const destination = state.selectedLocation;
    const campus = campusData[state.currentCampus];

    state.navigationBuilding = getNavigationBuilding(destination, campus);
    showNavigationModeSwitcher();
    setNavigationMode('route');
    
    // Use actual user location if available (and inside campus), otherwise use campus center
    // USE actual user location if available, regardless of boundary
    let startCoords = [campus.center.lat, campus.center.lng];
    let hasCampusUserLocation = false;
    
    if (state.userLocation) {
        // ✅ FIX: Use user location even if outside boundary
        startCoords = [state.userLocation.lat, state.userLocation.lng];
        hasCampusUserLocation = true;
    } else {
        // No location yet — try to get it now
        const campusLocation = await getCampusUserLocation(campus);
        if (campusLocation) {
            startCoords = campusLocation.coords;
            state.userLocation = {
                lat: startCoords[0],
                lng: startCoords[1],
                accuracy: campusLocation.accuracy
            };
            hasCampusUserLocation = true;
        } else {
            showNotification('Location not found. Using campus center as start.', 'warning');
        }
    }

    if (hasCampusUserLocation) {
        updateUserLocationMarker(startCoords[0], startCoords[1], state.userLocation?.accuracy);
    } else {
        removeUserLocationMarker();
    }

    startNavigationLocationWatch(); // ✅ keeps state.userLocation live while walking
    
    // Show loading notification
    showNotification('Calculating route...', 'info');
    
    // Determine if this is room navigation
    const isRoom = destination.matchType === 'room' || destination.buildingName;
    state.isRoomNavigation = isRoom;
    
    // Choose route color based on destination type
    const routeColor = isRoom ? '#9c27b0' : '#2c5aa0';  // Purple for rooms, Blue for buildings
    
    // Use whichever profile the Walk/Car/Bike selector is set to; 'auto'
    // falls back to the old distance-based logic.
    const routingProfile = pickRoutingProfile(startCoords, destination.coords);

    // Fetch and draw the route directly via OSRM — no more Leaflet Routing
    // Machine, which can't attach to a MapLibre map.
    try {
        const route = await fetchORSRoute(startCoords, destination.coords, routingProfile);

        msActivate(destination);

        state.currentRoute = {
            coordinates: route.coordinates,
            distance: route.summary.totalDistance,
            duration: route.summary.totalTime,
            instructions: route.instructions,
            profile: routingProfile,
            // ✅ Pin the destination this specific route was calculated for.
            // sync3DRoute() (and anything else that re-draws the active route
            // later, e.g. on a 2D↔3D switch) must read the destination from
            // HERE, not from state.selectedLocation — that field gets
            // reassigned every time the user opens a DIFFERENT location's
            // modal (e.g. to "Add as Next Stop"), even while this route stays
            // active. Reading state.selectedLocation there caused the active
            // route to visually snap to whatever building was last tapped.
            destination: destination
        };

        // ✅ ADD — tells voice-navigation.js a route is ready. That file
        // owns everything about turn-by-turn speech; this is the entire
        // interface into it, no other coupling.
        document.dispatchEvent(new CustomEvent('navRouteStarted', { detail: { route: state.currentRoute } }));

        drawRouteLine(route.coordinates, routeColor);
        addAnimatedOverlay(route.coordinates);
        addEndDottedLine(route.coordinates, destination);
        addStartDottedLine(startCoords, route.coordinates);

        // sync3DRoute() already fired once inside msActivate() above, but that
        // was before state.currentRoute held this route's actual coordinates —
        // re-sync now so the 3D map (if open) flies to and draws the real route.
        if (map3dState.active && map3dState.map) {
            sync3DRoute();
        }

        showCustomRouteInfo(route, destination, routingProfile);

        if (!state._routeRecordedThisNav) {
            state._routeRecordedThisNav = true;
            const destinationName =
                destination.name ||
                destination.displayName ||
                (destination.buildingName ? `${destination.buildingName} — ${destination.floor || 'Room'}` : null) ||
                'Unknown';

            recordRoute({
                route,
                destination: { ...destination, name: destinationName },
                startCoords,
                source: 'ors'
            });
        }

        showNotification('Route calculated!', 'success');
    } catch (err) {
        console.error('Routing error:', err);
        showNotification('Could not calculate route. Using direct path.', 'error');
        drawFallbackRoute(startCoords, destination, routingProfile);
    }

    // Close location modal
    document.getElementById('locationModal').classList.remove('active');
}



// Add animated dashed overlay on the route
function addAnimatedOverlay(coordinates) {
    const geojson = {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: coordinates.map(c => [c.lng, c.lat])
        }
    };

    if (!state.map.getSource('dashed-overlay')) {
        state.map.addSource('dashed-overlay', { type: 'geojson', data: geojson });
        state.map.addLayer({
            id: 'dashed-overlay-layer',
            type: 'line',
            source: 'dashed-overlay',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': '#ffffff',
                'line-width': 6,
                'line-opacity': 0.7,
                // ✅ Start on the same sequence the 3D route uses (see
                // route3DDashSequence below) instead of a separate hand-rolled
                // pattern — this is what keeps the two views' dash phase and
                // "flow" look identical from the very first frame.
                'line-dasharray': route3DDashSequence[0]
            }
        });
    } else {
        state.map.getSource('dashed-overlay').setData(geojson);
    }

    // ✅ Previously this ran on its own setInterval(..., 80) cycling through a
    // separate 7-step pattern — a full cycle took ~560ms. The 3D route (see
    // animate3DRouteDash) instead uses requestAnimationFrame stepping through
    // a 24-step sequence at ROUTE_3D_DASH_FRAME_MS (50ms) per step — a full
    // cycle takes ~1200ms, so the 2D route was visibly moving over 2x faster
    // than the 3D one. Reusing the exact same driver/sequence/cadence here
    // (just targeting the 2D layer instead of the 3D one) makes the two
    // views' route progression speed and timing genuinely identical, not
    // just similar-looking.
    if (state.dashAnimationFrame) {
        cancelAnimationFrame(state.dashAnimationFrame);
    }
    state.dashStep = -1;
    state.dashAnimationFrame = requestAnimationFrame(animate2DRouteDash);
}

// 2D equivalent of animate3DRouteDash() — same sequence, same frame cadence,
// same "only repaint on an actual step change" guard. Kept as a distinct
// function (rather than a shared helper) so the already-verified 3D
// animation loop is untouched by this change.
function animate2DRouteDash(timestamp) {
    if (!state.map || !state.map.getLayer('dashed-overlay-layer')) {
        state.dashAnimationFrame = null;
        return;
    }

    const stepIndex = Math.floor(timestamp / ROUTE_3D_DASH_FRAME_MS) % ROUTE_3D_DASH_STEPS;
    if (stepIndex !== state.dashStep) {
        state.map.setPaintProperty('dashed-overlay-layer', 'line-dasharray', route3DDashSequence[stepIndex]);
        state.dashStep = stepIndex;
    }

    state.dashAnimationFrame = requestAnimationFrame(animate2DRouteDash);
}

// Add dotted line directly to the room/destination (like the example image)
function addEndDottedLine(routeCoordinates, destination) {
    if (routeCoordinates.length < 1) return;

    const lastRoutePoint = routeCoordinates[routeCoordinates.length - 1];
    const isRoom = state.isRoomNavigation;
    const dottedColor = isRoom ? '#9c27b0' : '#2c5aa0';

    const geojson = {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [
                [lastRoutePoint.lng, lastRoutePoint.lat],
                [destination.coords[1], destination.coords[0]]
            ]
        }
    };

    if (!state.map.getSource('end-dotted-line')) {
        state.map.addSource('end-dotted-line', { type: 'geojson', data: geojson });
        state.map.addLayer({
            id: 'end-dotted-line-layer',
            type: 'line',
            source: 'end-dotted-line',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': dottedColor,
                'line-width': 6,
                'line-opacity': 0.9
            }
        });
    } else {
        state.map.getSource('end-dotted-line').setData(geojson);
        state.map.setPaintProperty('end-dotted-line-layer', 'line-color', dottedColor);
    }
}

const OFF_ROAD_LINK_THRESHOLD_METERS = 12;

function addStartDottedLine(userCoords, routeCoordinates) {
    if (!userCoords || !routeCoordinates || routeCoordinates.length < 1) {
        removeStartDottedLine();
        return;
    }

    // ✅ Measure the gap to the CLOSEST point anywhere on the route, not
    // just its first coordinate — otherwise this line keeps stretching
    // longer and longer the further you walk along the path, since your
    // distance back to the trailhead only grows.
    const nearestOnRoute = nearestPointOnPolyline(userCoords[0], userCoords[1], routeCoordinates);
    if (!nearestOnRoute) {
        removeStartDottedLine();
        return;
    }
    const gapMeters = nearestOnRoute.distanceMeters;

    if (gapMeters < OFF_ROAD_LINK_THRESHOLD_METERS) {
        removeStartDottedLine();
        return;
    }

    const isRoom = state.isRoomNavigation;
    const dottedColor = isRoom ? '#9c27b0' : '#2c5aa0';

    const geojson = {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [
                [userCoords[1], userCoords[0]],
                [nearestOnRoute.lng, nearestOnRoute.lat]
            ]
        }
    };

    if (!state.map.getSource('start-dotted-line')) {
        state.map.addSource('start-dotted-line', { type: 'geojson', data: geojson });
        state.map.addLayer({
            id: 'start-dotted-line-layer',
            type: 'line',
            source: 'start-dotted-line',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': dottedColor,
                'line-width': 5,
                'line-opacity': 0.85,
                'line-dasharray': [1, 1.6]
            }
        });
    } else {
        state.map.getSource('start-dotted-line').setData(geojson);
        state.map.setPaintProperty('start-dotted-line-layer', 'line-color', dottedColor);
    }
}

function removeStartDottedLine() {
    if (state.map.getLayer('start-dotted-line-layer')) state.map.removeLayer('start-dotted-line-layer');
    if (state.map.getSource('start-dotted-line')) state.map.removeSource('start-dotted-line');
}

function toggleBuildingPanel() {
    const panel = document.getElementById('buildingImagePanel');
    const willOpen = panel.style.display !== 'flex';

    if (willOpen) {
        window.closeSidebarPanel?.();
        window.AIChatWidget?.close?.();
    }

    panel.style.display = willOpen ? 'flex' : 'none';
    panel.setAttribute('aria-hidden', willOpen ? 'false' : 'true');
    document.body.classList.toggle('building-panel-open', willOpen);

    if (willOpen) populateBuildingPanel();
}

function closeBuildingPanel() {
    const panel = document.getElementById('buildingImagePanel');
    if (!panel) return;
    panel.style.display = 'none';
    panel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('building-panel-open');
}

function populateBuildingPanel() {
    const campus = campusData[state.currentCampus];
    const list = document.getElementById('buildingImageList');
    if (!list) return;

    // Only show buildings that have a photo
    const buildings = campus.locations.filter(l => l.photo);

    list.innerHTML = buildings.map(loc => `
        <div class="building-card" onclick="flyToBuilding(${loc.id})" id="buildingCard_${loc.id}">
            <img class="building-card-image" src="${loc.photo}" alt="${loc.name}" onerror="this.style.display='none'"/>
            <div class="building-card-title">🏛️ ${loc.name}</div>
        </div>
    `).join('');
}

function flyToBuilding(locationId) {
    const campus = campusData[state.currentCampus];
    const location = campus.locations.find(l => l.id === locationId);
    if (!location || !state.map) return;

    // Close the panel
    const buildingPanel = document.getElementById('buildingImagePanel');
    if (buildingPanel) {
        buildingPanel.style.display = 'none';
        buildingPanel.setAttribute('aria-hidden', 'true');
    }

    // coords is [lat, lng]
    const coords = normalizeCoords(location.coords);
    if (!coords) return;

    // MapLibre flyTo takes an options object — center is [lng, lat]
    state.map.flyTo({
        center: [coords[1], coords[0]],
        zoom: 19,
        animate: true,
        duration: 1200
    });

    // Show arrow after flying
    setTimeout(() => {
        pulseMarker(location);
    }, 1300);
}

function pulseMarker(location) {
    // Remove any existing arrow marker
    if (window._pulseMarker) {
        window._pulseMarker.remove();
        window._pulseMarker = null;
    }

    const coords = normalizeCoords(location.coords);
    if (!coords) return;

    const el = document.createElement('div');
    el.innerHTML = `
        <div style="
            display: flex;
            flex-direction: column;
            align-items: center;
            animation: bounceArrow 0.8s ease-in-out infinite;
        ">
            <div style="
                background: #6c63ff;
                color: white;
                font-size: 11px;
                font-weight: 700;
                padding: 4px 10px;
                border-radius: 20px;
                white-space: nowrap;
                box-shadow: 0 2px 8px rgba(108,99,255,0.5);
                margin-bottom: 4px;
            ">${location.name}</div>

            <svg width="28" height="36" viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg">
                <line x1="14" y1="0" x2="14" y2="26" stroke="#6c63ff" stroke-width="4" stroke-linecap="round"/>
                <polyline points="4,16 14,30 24,16" fill="none" stroke="#6c63ff" stroke-width="4"
                    stroke-linecap="round" stroke-linejoin="round"/>
            </svg>

            <div style="
                width: 14px;
                height: 14px;
                border-radius: 50%;
                background: #6c63ff;
                border: 3px solid white;
                box-shadow: 0 0 0 4px rgba(108,99,255,0.35);
                margin-top: -4px;
            "></div>
        </div>
    `;
    // iconAnchor was [60, 90] out of a [120, 90] box in Leaflet — i.e. bottom-center.
    // MapLibre's marker offset achieves the same: shift left by half width, up by full height.
    window._pulseMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([coords[1], coords[0]])
        .addTo(state.map);

    // Remove arrow after 4 seconds
    setTimeout(() => {
        if (window._pulseMarker) {
            window._pulseMarker.remove();
            window._pulseMarker = null;
        }
    }, 4000);
}
// Show custom route information
function showCustomRouteInfo(route, destination, profile) {
    const routeInfo = document.getElementById('routeInfo');
    const details = document.getElementById('routeDetails');

    const distanceKm = (route.summary.totalDistance / 1000).toFixed(2);
    const distanceM = Math.round(route.summary.totalDistance);
    const timeMin = Math.ceil(route.summary.totalTime / 60);
    const modeInfo = getTravelModeLabel(profile || state.currentRoute?.profile || state.travelMode);
    
    // Check if this is room navigation
    const isRoom = state.isRoomNavigation;
    const routeColor = isRoom ? '#9c27b0' : '#2c5aa0';
    
    // Generate turn-by-turn directions
    let directionsHTML = '';
    if (route.instructions && route.instructions.length > 0) {
        directionsHTML = `
            <div class="route-directions">
                <strong>📍 Turn-by-turn directions:</strong>
                ${route.instructions.map((step, i) => {
                    if (i === route.instructions.length - 1) return ''; // Skip "arrive" as we add custom one
                    
                    return `
                        <div class="route-step">
                            <span class="step-number" style="background: linear-gradient(135deg, ${routeColor} 0%, ${routeColor}dd 100%);">${i + 1}</span>
                            <span class="step-text">
                                ${getDirectionIcon(step.type)}${step.road ? ` <span style="color:#888; font-weight:400;">on ${step.road}</span>` : ''}
                                ${step.distance ? `<br><small style="color: #666;">${Math.round(step.distance)} m</small>` : ''}
                            </span>
                        </div>
                    `;
                }).join('')}
                <div class="route-step">
                    <span class="step-number" style="background: linear-gradient(135deg, ${routeColor} 0%, ${routeColor}dd 100%);">${route.instructions.length}</span>
                    <span class="step-text">🎯 Arrive at ${destination.name}</span>
                </div>
            </div>
        `;
    }
    
    details.innerHTML = `
        <div class="route-summary">
            <div class="route-stat" style="border-left-color: ${routeColor};">
                <strong>📏 Distance:</strong> ${distanceM < 1000 ? distanceM + ' m' : distanceKm + ' km'}
            </div>
            <div class="route-stat" style="border-left-color: ${routeColor};">
                <strong>${modeInfo.icon} ${modeInfo.label}:</strong> ${timeMin} min
            </div>
            <div class="route-stat" style="border-left-color: ${routeColor};">
                <strong>📍 Destination:</strong> ${destination.name}
            </div>
        </div>
        <div class="route-divider" style="background: linear-gradient(to right, ${routeColor}, transparent);"></div>
        ${directionsHTML}
    `;
    
    routeInfo.classList.remove('hidden');
}

// ✅ Single source of truth for instruction wording. getDirectionIcon()
// (the Turn-by-turn Directions panel, showCustomRouteInfo() above) and
// buildInstructionText() (voice-navigation.js) BOTH read from this one
// table — there is no second copy of instruction phrasing anywhere, so
// the panel and the spoken guidance can never drift out of sync.
const INSTRUCTION_LABELS = {
    'turn-left': { icon: '⬅️', text: 'Turn left' },
    'turn-right': { icon: '➡️', text: 'Turn right' },
    'turn-slight-left': { icon: '↩️', text: 'Slight left' },
    'turn-slight-right': { icon: '↪️', text: 'Slight right' },
    'turn-sharp-left': { icon: '↖️', text: 'Sharp left' },
    'turn-sharp-right': { icon: '↗️', text: 'Sharp right' },
    'straight': { icon: '⬆️', text: 'Continue straight' },
    'uturn': { icon: '↩️', text: 'Make a U-turn' },
    'arrive': { icon: '🎯', text: 'Arrive' },
    'depart': { icon: '🚶', text: 'Depart' },
    'merge': { icon: '↗️', text: 'Merge' },
    'on-ramp': { icon: '↗️', text: 'Take ramp' },
    'off-ramp': { icon: '↘️', text: 'Take exit' },
    'fork': { icon: '↗️', text: 'Keep' },
    'end-of-road': { icon: '⬆️', text: 'Continue' },
    'continue': { icon: '⬆️', text: 'Continue' },
    'roundabout': { icon: '🔄', text: 'Roundabout' }
};

// Get direction icon based on instruction type — used by the Turn-by-turn
// Directions panel. Unchanged behavior/output, now sourced from the table
// above instead of its own separate copy.
function getDirectionIcon(type) {
    const entry = INSTRUCTION_LABELS[type];
    return entry ? `${entry.icon} ${entry.text}` : '➡️';
}

// ✅ ADD — plain-language spoken phrasing for a turn-by-turn step, built
// from the EXACT same INSTRUCTION_LABELS table the panel uses above, plus
// the same `step.road` field the panel already renders as "on {road}".
// This is the ONLY function that turns an instruction into speech text —
// voice-navigation.js calls this instead of maintaining its own wording.
//
// distanceMetersOverride lets the caller speak the user's LIVE remaining
// distance to the maneuver (what voice guidance needs) instead of the
// step's fixed segment length (what the panel shows) — only the NUMBER
// differs, the wording itself is identical either way.
//
// destinationName mirrors what showCustomRouteInfo() does for the final
// step: the panel doesn't speak the raw 'arrive' label, it prints
// "🎯 Arrive at {destination.name}" — so the spoken version says the same.
function buildInstructionText(step, distanceMetersOverride, destinationName) {
    if (!step) return '';

    if (step.type === 'arrive') {
        return destinationName
            ? `You have arrived at ${destinationName}.`
            : 'You have arrived at your destination.';
    }

    const entry = INSTRUCTION_LABELS[step.type];
    const label = entry ? entry.text : 'Continue';
    const roadPart = step.road ? ` on ${step.road}` : '';
    const dist = (typeof distanceMetersOverride === 'number') ? distanceMetersOverride : step.distance;
    const distPart = (typeof dist === 'number' && dist > 0) ? ` in ${Math.round(dist)} meters` : '';

    return `${label}${roadPart}${distPart}.`;
}
window.buildInstructionText = buildInstructionText;

// Fallback route if routing fails
function drawFallbackRoute(start, destination, profile = 'foot') {
    const geojson = {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [
                [start[1], start[0]],
                [destination.coords[1], destination.coords[0]]
            ]
        }
    };

    if (!state.map.getSource('fallback-route-line')) {
        state.map.addSource('fallback-route-line', { type: 'geojson', data: geojson });
        state.map.addLayer({
            id: 'fallback-route-line-layer',
            type: 'line',
            source: 'fallback-route-line',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': '#ea4335',
                'line-width': 5,
                'line-opacity': 0.7,
                'line-dasharray': [2, 2]
            }
        });
    } else {
        state.map.getSource('fallback-route-line').setData(geojson);
    }

    const lngs = geojson.geometry.coordinates.map(c => c[0]);
    const lats = geojson.geometry.coordinates.map(c => c[1]);
    state.map.fitBounds(
        [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
        { padding: 80, maxZoom: 18 }
    );

    const distance = calculateDistance(start, destination.coords);

    // ✅ The direct-line ETA now scales with the selected travel mode
    // instead of always assuming walking pace — a Car/Bike fallback that
    // still reported a walking-speed estimate was misleading.
    const FALLBACK_SPEED_M_PER_MIN = { foot: 80, 'cycling-regular': 250, 'driving-car': 500 };
    const estimatedTime = Math.ceil(distance / (FALLBACK_SPEED_M_PER_MIN[profile] || FALLBACK_SPEED_M_PER_MIN.foot));

    const { label: timeLabel, icon: timeIcon } = getTravelModeLabel(profile);

    const routeInfo = document.getElementById('routeInfo');
    const details = document.getElementById('routeDetails');

    // ✅ Root cause of "Could not find walking route" appearing for Car/Bike:
    // this message was hardcoded to always say "walking route" regardless
    // of which profile actually failed. The failure itself is usually
    // legitimate — Car/Bike routing runs against the real public road
    // network, and most intra-campus distances are only connected by
    // pedestrian footpaths with no drivable road between them, so
    // GraphHopper correctly reports no route for those modes. The fix is
    // accurate messaging (name the mode that failed) plus a mode-correct
    // ETA, not silently forcing a fake route.
    const modeNoun = { foot: 'walking', 'cycling-regular': 'cycling', 'driving-car': 'driving' }[profile] || 'walking';

    details.innerHTML = `
        <div class="route-summary">
            <div class="route-stat">
                <strong>📏 Distance:</strong> ${Math.round(distance)} m (direct)
            </div>
            <div class="route-stat">
                <strong>${timeIcon} ${timeLabel}:</strong> ${estimatedTime} min
            </div>
            <div class="route-stat">
                <strong>📍 Destination:</strong> ${destination.name}
            </div>
        </div>
        <div class="route-divider"></div>
        <p style="color: #ea4335; font-size: 13px; padding: 10px; background: #fee; border-radius: 6px;">
            ⚠️ Could not find a ${modeNoun} route to this destination. Showing a direct path — actual distance/time may differ. Try a different travel mode if one is available.
        </p>
    `;

    routeInfo.classList.remove('hidden');
}

async function recordRoute({ route, destination, startCoords, source }) {
    if (!route || !destination || !startCoords) return;

    const entry = {
        id: Date.now(),
        campus: state.currentCampus,
        source: source || 'ors',
        isRoom: state.isRoomNavigation,
        start: { lat: startCoords[0], lng: startCoords[1] },
        destination: {
            name: destination.name,
            coords: destination.coords
        },
        distance: route.summary?.totalDistance || 0,
        duration:  route.summary?.totalTime    || 0,
        createdAt: new Date().toISOString()
    };

    // Save locally
    state.routeHistory.push(entry);
    if (state.routeHistory.length > 200) {
        state.routeHistory = state.routeHistory.slice(-200);
    }
    saveData();

    // ✅ Save to database
    const session = getAuthSession();
    if (session?.userId) {
        try {
            await fetch('/api/routes/record', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId:      session.userId,
                    destination: destination.name || destination.displayName || 'Room Navigation',
                    distance:    entry.distance,
                    duration:    entry.duration,
                    isRoom:      entry.isRoom,
                    campus:      entry.campus
                })
            });
        } catch (e) {
            console.warn('Could not save route to DB:', e);
        }
    }
}

// Updated clearRoute function
function clearRoute() {
    // ❌ REMOVED stopNavigationLocationWatch() — clearing a route must only
    // remove the route/UI, never the GPS watcher, dead-reckoning loop, or
    // compass listener. Location tracking is independent of navigation and
    // should keep running whether the user is navigating or just viewing
    // the map, exactly like Google Maps' blue dot.
    // Routing is now plain MapLibre layers/sources — one function cleans it all up.
    removeRouteLine();
    
    // Clear waypoint markers
    if (state.waypointMarkers) {
        state.waypointMarkers.forEach(marker => marker.remove());
        state.waypointMarkers = [];
    }
    
    // Stop animation
    if (state.routeAnimation) {
        clearInterval(state.routeAnimation);
        state.routeAnimation = null;
    }
    
    // Clear current route data
    state.currentRoute = null;
    state.isRoomNavigation = false;
    state._routeRecordedThisNav = false;

    // ✅ ADD — voice-navigation.js stops announcing and hides its UI.
    document.dispatchEvent(new CustomEvent('navRouteCleared'));

    document.getElementById('routeInfo').classList.add('hidden');
}

function minimizeRoutePanel() {
    document.getElementById('routeInfo').classList.add('hidden');

    // ✅ Remove highlight from Route Details button
    const routeBtn = document.getElementById('navModeRoute');
    if (routeBtn) routeBtn.classList.remove('is-active');

    showNotification('Route still visible on map', 'info');
}

// Complete route removal
function clearRouteCompletely() {
    // ❌ REMOVED stopNavigationLocationWatch() — same reasoning as clearRoute()
    // above: fully clearing a route (e.g. leaving navigation mode entirely)
    // still must not stop location tracking. The GPS watcher, dead-reckoning
    // loop, and compass listener all keep running so the blue dot and its
    // beam continue updating in the background regardless of route state.
    state._routeRecordedThisNav = false;


    // ✅ Reset multi-stop v2
    msClearArrivalCheck();
    msInit();
    // Routing is now plain MapLibre layers/sources — one function cleans it all up.
    removeRouteLine();
    
    // Clear waypoint markers
    if (state.waypointMarkers) {
        state.waypointMarkers.forEach(marker => marker.remove());
        state.waypointMarkers = [];
    }
    
    // Stop animation
    if (state.routeAnimation) {
        clearInterval(state.routeAnimation);
        state.routeAnimation = null;
    }
    
    // Clear current route data
    state.currentRoute = null;
    state.isRoomNavigation = false;
    state._routeRecordedThisNav = false;

    // ✅ ADD — same as clearRoute() above.
    document.dispatchEvent(new CustomEvent('navRouteCleared'));

    document.getElementById('routeInfo').classList.add('hidden');
    hideNavigationModeSwitcher();
    closeVirtualTour();
    if (map3dState.active) exit3DMap();
    
    
    // ✅ ADD THIS — reset the 3D button label/state
    const view3dBtn = document.getElementById('navMode3d');
    if (view3dBtn) {
        view3dBtn.textContent = '3D View';
        view3dBtn.classList.remove('is-active');
    }
    
    state.navigationMode = 'route'; 
    state.navigationBuilding = null;
    showNotification('Route cleared', 'success');
}

// Go back to the building popup from route details
function goBackFromRoute() {
    const building = state.lastRoomBuilding || state.rooms.activeBuilding;
    clearRouteCompletely();

    if (building) {
        state.rooms.activeBuilding = building;
        RoomMarkerManager.goBackToBuilding();
        return;
    }

    showNotification('Route cleared', 'info');
}

function showNavigationModeSwitcher() {
    const switcher = document.getElementById('navModeSwitcher');
    if (switcher) {
        switcher.classList.remove('hidden');
    }
}

function hideNavigationModeSwitcher() {
    const switcher = document.getElementById('navModeSwitcher');
    if (switcher) {
        switcher.classList.add('hidden');
    }
}

function setNavigationMode(mode) {
    state.navigationMode = mode;

    const routeInfo = document.getElementById('routeInfo');
    const mapBtn = document.getElementById('navModeMap');
    const routeBtn = document.getElementById('navModeRoute');

    if (mode === 'map') {
        mapBtn?.classList.add('is-active');
        routeBtn?.classList.remove('is-active');
        routeInfo?.classList.add('hidden');
        closeVirtualTour();
        return;
    }

    if (mode === 'route') {
        routeBtn?.classList.add('is-active');
        mapBtn?.classList.remove('is-active');
        closeVirtualTour();
        if (routeInfo) routeInfo.classList.remove('hidden');
        return;
    }
}

function toggleNav3D() {
    const view3dBtn = document.getElementById('navMode3d');
    closeVirtualTour();

    if (map3dState.active) {
        exit3DMap();
        if (view3dBtn) {
            view3dBtn.textContent = '3D View';
            view3dBtn.classList.remove('is-active');
        }
    } else {
        enter3DMap();
        if (view3dBtn) {
            view3dBtn.textContent = 'Exit 3D';
            view3dBtn.classList.add('is-active');
        }
    }
}

function getNavigationBuilding(destination, campus) {
    if (destination?.buildingName) {
        return campus.locations.find(loc => loc.name === destination.buildingName) || null;
    }

    if (destination?.name) {
        return campus.locations.find(loc => loc.name === destination.name) || null;
    }

    return null;
}
// Quick Actions
function handleQuickAction(action) {
    switch(action) {
        case 'findLocation':
            setUserLocation();
            break;
        case 'accessibleRoutes':
            toggleAccessiblePaths();
            break;
        case 'savedLocations':
            showSavedLocations();
            break;
    }
}

function startNavigationLocationWatch() {
    startCompassTracking(); // Google-Maps-style live beam rotation, see below
    if (!navigator.geolocation) return;

    if (state.watchId) {
        navigator.geolocation.clearWatch(state.watchId);
        state.watchId = null;
    }

    const options = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };

    state.watchId = navigator.geolocation.watchPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            const accuracy = pos.coords.accuracy;

            // ✅ Sanity check: during an active multi-stop trip, a GPS reading
            // that lands far outside the campus boundary is more likely to be
            // indoor/GPS drift (or testing away from campus) than an actual
            // location change. Rather than hand-dampening it ourselves, we
            // express "trust this fix less" as an accuracy inflation factor
            // and let the Kalman filter (location-filter.js) weight it down
            // naturally — same intent as before, just no longer a bespoke
            // formula living in this file.
            let boundaryAccuracyInflation = 1; // 1 = normal trust, higher = less trust
            if (state.multiStop.active) {
                const campus = campusData[state.currentCampus];
                const inside = !campus?.boundary || isPointInsideBoundary([lat, lng], campus.boundary);
                if (!inside) {
                    console.warn(`GPS reading outside campus boundary during multi-stop trip — dampened, not dropped (${lat}, ${lng})`);
                    boundaryAccuracyInflation = 6; // treat as if ~6x less accurate — still nudges the dot, just barely
                }
            }

            // ✅ Outlier rejection + Kalman smoothing (location-filter.js).
            // A single wild spike (GPS multipath off a nearby building) is
            // held back until a follow-up fix confirms it's real movement;
            // otherwise the filter blends this fix in, weighted by its own
            // accuracy and the filter's current uncertainty — replacing the
            // old hand-tuned SMOOTHING/CATCH_UP_DISTANCE constants entirely.
            const filtered = locationFilter.process(
                lat, lng, accuracy,
                pos.timestamp || Date.now(),
                boundaryAccuracyInflation
            );

            // Rejected as a likely one-off spike — skip this update
            // entirely rather than let it touch the marker, dead
            // reckoning, or route/multi-stop logic.
            if (!filtered) return;

            let smoothedLat = filtered.lat;
            let smoothedLng = filtered.lng;

            // ✅ If the reading lands inside a building footprint, nudge it
            // toward the nearest building edge instead — GPS drift into a
            // building outline while walking outside is far more likely than
            // the user actually being inside it mid-navigation.
            const footprint = findContainingFootprint(smoothedLat, smoothedLng);
            if (footprint) {
                const edgePoint = nearestPointOnPolygonBoundary(smoothedLat, smoothedLng, footprint.coords);
                if (edgePoint) {
                    const SNAP = 0.5; // partial pull toward the edge, not a hard snap
                    smoothedLat = smoothedLat + (edgePoint[0] - smoothedLat) * SNAP;
                    smoothedLng = smoothedLng + (edgePoint[1] - smoothedLng) * SNAP;
                }
            }

            // ✅ Snap toward the route line itself when reasonably close to
            // it, so the dot rides along the path instead of floating
            // beside it from ordinary sideways GPS drift.
            if (state.currentRoute && state.currentRoute.coordinates && state.currentRoute.coordinates.length > 1) {
                const nearestOnRoute = nearestPointOnPolyline(smoothedLat, smoothedLng, state.currentRoute.coordinates);
                const ROUTE_SNAP_DISTANCE = 12; // meters — only snap when close enough that it's clearly the same path
                if (nearestOnRoute && nearestOnRoute.distanceMeters <= ROUTE_SNAP_DISTANCE) {
                    const ROUTE_SNAP = 0.6; // partial pull onto the line, not a hard snap
                    smoothedLat = smoothedLat + (nearestOnRoute.lat - smoothedLat) * ROUTE_SNAP;
                    smoothedLng = smoothedLng + (nearestOnRoute.lng - smoothedLng) * ROUTE_SNAP;
                }
            }

            state.userLocation = { lat: smoothedLat, lng: smoothedLng, accuracy };
            updateUserLocationMarker(smoothedLat, smoothedLng, accuracy);

            // ✅ Derive speed/heading from the gap between this fix and the
            // previous dead-reckoning anchor as a fallback. Many devices
            // (Android especially) frequently report pos.coords.speed and
            // pos.coords.heading as null even while the user is actively
            // walking — previously that silently disabled dead reckoning
            // entirely (its MIN_SPEED/heading checks require real numbers),
            // which is exactly what made the dot visibly lag/stall between
            // GPS fixes instead of gliding smoothly like Google Maps.
            const now = Date.now();
            let derivedSpeed = null;
            let derivedHeading = null;
            if (state.deadReckoning.baseLat != null && state.deadReckoning.baseTime) {
                const dt = (now - state.deadReckoning.baseTime) / 1000;
                if (dt > 0.1) { // avoid noisy divide on back-to-back fixes
                    const distM = calculateDistance(
                        [state.deadReckoning.baseLat, state.deadReckoning.baseLng],
                        [smoothedLat, smoothedLng]
                    );
                    derivedSpeed = distM / dt;
                    derivedHeading = calculateBearing(
                        [state.deadReckoning.baseLat, state.deadReckoning.baseLng],
                        [smoothedLat, smoothedLng]
                    );
                }
            }

            // Re-anchor dead reckoning to this real fix. Prefer the OS's own
            // fused speed/heading (GPS + compass + accelerometer) when it
            // actually reports one; otherwise fall back to the derived
            // values above so the glide never silently stops.
            state.deadReckoning.baseLat = smoothedLat;
            state.deadReckoning.baseLng = smoothedLng;
            state.deadReckoning.baseTime = now;
            state.deadReckoning.speed = (typeof pos.coords.speed === 'number' && pos.coords.speed > 0)
                ? pos.coords.speed
                : derivedSpeed;
            state.deadReckoning.heading = (typeof pos.coords.heading === 'number' && !Number.isNaN(pos.coords.heading))
                ? pos.coords.heading
                : derivedHeading;
            state.deadReckoning.accuracy = accuracy;
            // Only let GPS heading drive the beam when the compass isn't
            // actively supplying fresher readings — prevents the two from
            // fighting over the beam's rotation.
            if (!compassState.supported || Date.now() - compassState.lastUpdate > COMPASS_STALE_MS) {
                applyUserMarkerHeading(
                    typeof pos.coords.heading === 'number' ? pos.coords.heading : derivedHeading,
                    typeof pos.coords.speed === 'number' ? pos.coords.speed : derivedSpeed
                );
            }
            startDeadReckoningLoop();

            if (state.currentRoute && state.currentRoute.coordinates && state.currentRoute.coordinates.length) {
                addStartDottedLine([smoothedLat, smoothedLng], state.currentRoute.coordinates);
                if (map3dState.active && map3dState.map) {
                    addStartDottedLine3D([smoothedLat, smoothedLng], state.currentRoute.coordinates);
                }
            }

            // ✅ ADD — final smoothed/snapped fix for this tick. This is the
            // ENTIRE feed voice-navigation.js gets; it never reads GPS,
            // state.userLocation, or the Kalman filter directly.
            document.dispatchEvent(new CustomEvent('navLocationUpdate', {
                detail: { lat: smoothedLat, lng: smoothedLng, accuracy }
            }));
        },
        (error) => console.warn('Navigation location watch error:', error.message),
        options
    );
}

// ✅ Dead reckoning: projects the dot forward along its last known heading
// and speed (both already fused by the OS from GPS + compass + accelerometer,
// exposed via pos.coords) so it keeps gliding smoothly between real GPS
// fixes instead of sitting still until the next one arrives — the same
// trick Google Maps uses.
function projectPosition(lat, lng, headingDeg, distanceMeters) {
    const R = 6371000; // Earth radius, meters
    const heading = headingDeg * Math.PI / 180;
    const latRad = lat * Math.PI / 180;
    const lngRad = lng * Math.PI / 180;
    const angularDistance = distanceMeters / R;

    const newLatRad = Math.asin(
        Math.sin(latRad) * Math.cos(angularDistance) +
        Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(heading)
    );
    const newLngRad = lngRad + Math.atan2(
        Math.sin(heading) * Math.sin(angularDistance) * Math.cos(latRad),
        Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(newLatRad)
    );

    return [newLatRad * 180 / Math.PI, newLngRad * 180 / Math.PI];
}

function startDeadReckoningLoop() {
    if (state.deadReckoning.active) return; // already running
    state.deadReckoning.active = true;

    const MAX_EXTRAPOLATION_SECONDS = 4; // stop projecting forward if fixes stall this long
    const MIN_SPEED = 0.3;               // m/s — below this, treat as stationary (avoid drift while standing still)

    function tick() {
        if (!state.deadReckoning.active) return;

        const dr = state.deadReckoning;
        const elapsed = (Date.now() - dr.baseTime) / 1000;

        if (
            dr.baseLat != null &&
            typeof dr.speed === 'number' && dr.speed > MIN_SPEED &&
            typeof dr.heading === 'number' && !Number.isNaN(dr.heading) &&
            elapsed > 0 && elapsed < MAX_EXTRAPOLATION_SECONDS
        ) {
            const distance = dr.speed * elapsed;
            const [projLat, projLng] = projectPosition(dr.baseLat, dr.baseLng, dr.heading, distance);
            updateUserLocationMarker(projLat, projLng, dr.accuracy);
        }

        state.deadReckoning.rafId = requestAnimationFrame(tick);
    }

    state.deadReckoning.rafId = requestAnimationFrame(tick);
}

function stopDeadReckoningLoop() {
    state.deadReckoning.active = false;
    if (state.deadReckoning.rafId) {
        cancelAnimationFrame(state.deadReckoning.rafId);
        state.deadReckoning.rafId = null;
    }
}

function stopNavigationLocationWatch() {
    if (state.watchId) {
        navigator.geolocation.clearWatch(state.watchId);
        state.watchId = null;
    }
    stopDeadReckoningLoop();
}

function setUserLocation() {
    const btn = document.querySelector('.quick-access-btn[data-action="findLocation"]');

    // Ignore a repeat tap while a request is already in flight instead of
    // starting a second overlapping watchPosition chain.
    if (btn && btn.disabled) return;

    startCompassTracking(); // fired synchronously from this click so iOS's permission prompt is allowed

    if (!navigator.geolocation) {
        showNotification('Geolocation is not supported by your browser', 'error');
        return;
    }

    // ✅ If the live background watch is already running (started on a
    // previous tap), just re-center on the latest tracked position instead
    // of kicking off a brand-new acquireAccurateLocation() — a second
    // concurrent GPS acquisition competes with the running watch and can
    // stall or silently fail on many devices, which is why re-tapping
    // stopped re-centering the map after the first successful fix.
    if (state.watchId && state.userLocation) {
        updateUserLocationMarker(
            state.userLocation.lat,
            state.userLocation.lng,
            state.userLocation.accuracy,
            { showPopup: true, pan: true }
        );
        showNotification(`Location found! Accuracy: ±${Math.round(state.userLocation.accuracy)}m`, 'success');
        return;
    }

    // ── Permission gate — checked only now, the first time location is
    // actually needed. Never re-prompts once granted; never retries a
    // hard denial (the browser won't re-prompt a denied origin anyway).
    getGeoPermissionState().then((permState) => {
        if (permState === 'denied') {
            showLocationBlockedInstructions();
        } else if (permState === 'granted') {
            beginLocationAcquisition(btn);
        } else {
            // 'prompt' (never asked) or 'unsupported' (older Safari without
            // the Permissions API) — explain first, then trigger the real
            // native browser prompt only when the user taps Allow.
            showLocationPermissionExplainer(() => beginLocationAcquisition(btn));
        }
    });
}

function beginLocationAcquisition(btn) {
    if (btn) {
        btn.disabled = true;
        btn.classList.add('is-loading');
    }

    const loadingToast = showNotification('Getting your location...', 'loading', { persist: true });

    acquireAccurateLocation({
        onStatus: (msg) => loadingToast.update(msg)
    }).then(({ position, error }) => {
        loadingToast.dismiss();

        if (btn) {
            btn.disabled = false;
            btn.classList.remove('is-loading');
        }

        if (!position) {
            // A hard denial can't be fixed by retrying — show the settings
            // panel instead of a toast that just disappears in a few seconds.
            if (error && error.code === 1) {
                showLocationBlockedInstructions();
            } else {
                showNotification(error?.message || 'Unable to get your location. Please check your device settings and try again.', 'error');
            }
            console.error('Geolocation error:', error);
            return;
        }

        const userLat = position.coords.latitude;
        const userLng = position.coords.longitude;
        const accuracy = position.coords.accuracy;

        console.log('User location:', userLat, userLng, 'Accuracy:', accuracy, 'meters');

        updateUserLocationMarker(userLat, userLng, accuracy, { showPopup: true, pan: true });
        state.userLocation = { lat: userLat, lng: userLng, accuracy };

        // ✅ Keep tracking live from here on, same as tapping Navigate does —
        // so the blue dot keeps drifting with you even before you start a route.
        startNavigationLocationWatch();

        // A successful fix from the low-accuracy fallback stage is still a
        // real fix — just let the accuracy figure speak for itself rather
        // than a hard-coded "found!" message implying GPS precision.
        showNotification(`Location found! Accuracy: ±${Math.round(accuracy)}m`, 'success');
    });
}

function toggleAccessiblePaths() {
    state.accessibleOnly = !state.accessibleOnly;
    showNotification(state.accessibleOnly ? 'Showing accessible routes only' : 'Showing all routes');
}

function saveCurrentLocation() {

    const session = getAuthSession();
    if (!Permissions.canUseFeature(session?.role || 'VISITOR', 'saveLocations')) {
        showNotification('This feature is not available for your account type.', 'error');
        return;
    }

    if (!state.selectedLocation) return;
    
    const exists = state.savedLocations.find(loc => loc.id === state.selectedLocation.id);
    if (!exists) {
        state.savedLocations.push(state.selectedLocation);
        saveData();
        showNotification(`${state.selectedLocation.name} saved!`);
    } else {
        showNotification('Location already saved!');
    }
}

function showSavedLocations() {
    if (state.savedLocations.length === 0) {
        showNotification('No saved locations yet!');
        return;
    }
    
    const resultsDiv = document.getElementById('searchResults');
    resultsDiv.innerHTML = '<div class="search-result-item" style="font-weight: bold; background: #f0f7ff;">⭐ Saved Locations</div>';
    
    state.savedLocations.forEach(loc => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.innerHTML = `
            <span class="result-name">${loc.name}</span>
            <span class="result-type">${loc.type}</span>
        `;
        item.addEventListener('click', () => {
            showLocationDetails(loc);
            state.map.jumpTo({ center: [loc.coords[1], loc.coords[0]], zoom: 18 });
            resultsDiv.classList.add('hidden');
        });
        resultsDiv.appendChild(item);
    });
    
    resultsDiv.classList.remove('hidden');
}

// ============================================
// 🆕 MULTI-STOP NAVIGATION V2
// ============================================

function msInit() {
    msClearPaleRoutes();
    state.multiStop = {
        active: false,
        stops: [],
        currentIndex: 0,
        countdownTimer: null,
        arrivalChecker: null,
        paleLayerIds: []
    };
    document.getElementById('msProgressBar').style.display = 'none';
    document.getElementById('msArrivedSection').style.display = 'none';
    document.getElementById('msOfflineBanner').style.display = 'none';
    document.getElementById('msCountdownBanner').style.display = 'none';
}

// Normalizes ANY location object — a raw campusData building, a raw room
// (with buildingName attached, e.g. from showRoomDetails/window.navigateToRoom),
// a bare {name, coords} room from RoomMarkerManager, or an already-normalized
// search-modal item — into one consistent shape used everywhere in multi-stop:
//   { ...original fields, id: <globally-unique string>, matchType: 'building'|'room', buildingName? }
//
// This matters because campusData room ids are only unique WITHIN a building
// (many buildings reuse ids like 101, 102, 201...) and plain numeric building
// ids can look identical in shape to a stray room id. Without a single shared
// id scheme, stops added from different entry points (search modal, "Add as
// Next Stop" button, room marker popups, admin room links) could silently
// collide or fail to dedupe against each other.
function msNormalizeLocation(location) {
    if (!location) return null;

    // Already normalized (search modal items, or a stop we've normalized
    // before) — id is already globally unique, pass through untouched.
    if (location.matchType === 'building' || location.matchType === 'room') {
        return location;
    }

    const campus = campusData[state.currentCampus];

    // Raw room object carrying a buildingName (showRoomDetails, window.navigateToRoom,
    // or anything else that knows which building it came from).
    if (location.buildingName) {
        const building = campus?.locations.find(loc => loc.name === location.buildingName);
        const buildingKey = building ? building.id : 'unknownbuilding';
        const roomKey = location.id ?? location.name;
        return {
            ...location,
            id: `room_${buildingKey}_${roomKey}`,
            matchType: 'room',
            buildingName: location.buildingName
        };
    }

    // Raw building object straight from campusData (has a `type` + is present
    // in the current campus's locations list, no buildingName attached).
    if (location.type && campus?.locations.some(l => l.id === location.id && l.type === location.type)) {
        return {
            ...location,
            id: `building_${location.id}`,
            matchType: 'building'
        };
    }

    // Last-resort fallback (e.g. a bare {name, coords} room with no building
    // context at all) — still give it a stable, reasonably unique id.
    return {
        ...location,
        id: location.id ?? `loc_${location.name}_${location.coords?.[0]}_${location.coords?.[1]}`,
        matchType: location.matchType || 'room'
    };
}

function msActivate(destination) {
    // Called when navigation starts
    const normalized = msNormalizeLocation(destination);
    if (!state.multiStop.active) {
        state.multiStop.active = true;
        state.multiStop.stops = [{
            location: normalized,
            status: 'current',
            cachedRoute: null
        }];
        state.multiStop.currentIndex = 0;
    }
    msRenderProgress();
    msStartArrivalCheck(destination);
}

function msRenderProgress() {
    const ms = state.multiStop;
    if (!ms.active || ms.stops.length === 0) {
        document.getElementById('msProgressBar').style.display = 'none';
        return;
    }

    document.getElementById('msProgressBar').style.display = 'block';

    const total = ms.stops.length;
    const current = ms.currentIndex;

    // Update counter
    document.getElementById('msStopCount').textContent =
        `Stop ${current + 1} of ${total}`;

    // Build step indicator (dots connected by lines)
    const indicator = document.getElementById('msStepIndicator');
    indicator.innerHTML = ms.stops.map((stop, i) => {
        const isDone = stop.status === 'done';
        const isCurrent = stop.status === 'current';
        const isPending = stop.status === 'pending';

        const dotColor = isDone ? '#34a853' : isCurrent ? '#2c5aa0' : '#ccc';
        const dotBorder = isCurrent ? '3px solid #2c5aa0' : 'none';
        const lineColor = isDone ? '#34a853' : '#e0e0e0';

        return `
            <div style="display:flex; align-items:center; flex:1;">
                <div style="
                    width:${isCurrent ? '16px' : '12px'};
                    height:${isCurrent ? '16px' : '12px'};
                    border-radius:50%;
                    background:${dotColor};
                    border:${dotBorder};
                    flex-shrink:0;
                    transition: all 0.3s;
                    ${isCurrent ? 'box-shadow:0 0 0 4px rgba(44,90,160,0.2);' : ''}
                "></div>
                ${i < ms.stops.length - 1 ? `
                    <div style="
                        flex:1;
                        height:3px;
                        background:${lineColor};
                        transition: background 0.3s;
                    "></div>
                ` : ''}
            </div>
        `;
    }).join('');

    // Build stop names list
    const namesList = document.getElementById('msStopNames');
    namesList.innerHTML = ms.stops.map((stop, i) => {
        const isDone = stop.status === 'done';
        const isCurrent = stop.status === 'current';
        const isClickable = !isCurrent; // tap any other stop to make it the active one

        return `
            <div ${isClickable ? `onclick="msJumpToStop(${i})"` : ''} style="
                display:flex;
                align-items:center;
                gap:8px;
                padding:6px 8px;
                border-radius:8px;
                background:${isCurrent ? '#e8f0fe' : 'transparent'};
                opacity:${isDone ? '0.5' : '1'};
                cursor:${isClickable ? 'pointer' : 'default'};
            ">
                <span style="
                    font-size:11px;
                    font-weight:700;
                    color:${isDone ? '#34a853' : isCurrent ? '#2c5aa0' : '#999'};
                    width:16px;
                    text-align:center;
                ">${isDone ? '✓' : i + 1}</span>
                <span style="
                    font-size:12px;
                    font-weight:${isCurrent ? '600' : '400'};
                    color:${isCurrent ? '#2c5aa0' : isDone ? '#666' : '#888'};
                    flex:1;
                ">${stop.location.name}</span>
                ${stop.cachedRoute ? `
                    <span style="
                        font-size:10px;
                        background:#e8f5e9;
                        color:#2e7d32;
                        padding:2px 6px;
                        border-radius:10px;
                        font-weight:600;
                    ">📥 Cached</span>
                ` : ''}
                ${stop.status === 'pending' ? `
                    <button onclick="event.stopPropagation(); msRemoveStop(${i})" style="
                        background:none;
                        border:none;
                        color:#ea4335;
                        cursor:pointer;
                        font-size:13px;
                        padding:0 2px;
                    ">✕</button>
                ` : ''}
            </div>
        `;
    }).join('');

    msRenderPaleRoutes();

    // If the 3D view is currently open, re-sync it too — otherwise jumping
    // stops, adding stops, or arriving only ever updated the 2D map, and 3D
    // would keep showing whatever route was active when you first opened it.
    if (map3dState.active && map3dState.map) {
        sync3DRoute();
    }
}

// Draws every non-active stop's route as a thin, pale "preview" line so a
// multi-stop trip (e.g. CCIT then COE) shows both lanes on the map at once —
// the current leg stays full color via the normal route-line layer, while
// the others fade into the background instead of disappearing.
function msRenderPaleRoutes() {
    msClearPaleRoutes();
    const ms = state.multiStop;
    if (!ms.active || !state.map) return;

    ms.stops.forEach((stop, i) => {
        if (i === ms.currentIndex) return; // active leg — drawn full color elsewhere
        if (!stop.cachedRoute || !stop.cachedRoute.coordinates.length) return;

        const coords = stop.cachedRoute.coordinates.map(c => [c[1], c[0]]); // [lat,lng] -> [lng,lat]
        const sourceId = `ms-pale-route-${i}`;
        const layerId = `${sourceId}-layer`;
        const isDone = stop.status === 'done';

        state.map.addSource(sourceId, {
            type: 'geojson',
            data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } }
        });
        state.map.addLayer({
            id: layerId,
            type: 'line',
            source: sourceId,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': isDone ? '#9aa0a6' : '#8ab4f8',
                'line-width': 4,
                'line-opacity': isDone ? 0.35 : 0.5,
                'line-dasharray': [1.5, 1.2]
            }
        });

        ms.paleLayerIds.push({ sourceId, layerId });
    });
}

function msClearPaleRoutes() {
    if (!state.map) return;
    const ms = state.multiStop;
    (ms.paleLayerIds || []).forEach(({ sourceId, layerId }) => {
        if (state.map.getLayer(layerId)) state.map.removeLayer(layerId);
        if (state.map.getSource(sourceId)) state.map.removeSource(sourceId);
    });
    if (ms.paleLayerIds) ms.paleLayerIds = [];
}

// Lets the user tap a different pending/done stop and jump to it directly,
// instead of always advancing strictly in add-order. Fetches a fresh route
// from the user's live GPS position (more accurate than reusing the old
// prev-stop-based cached route for a leg that was never actually next).
async function msJumpToStop(index) {
    const ms = state.multiStop;
    if (!ms.active) return;
    const target = ms.stops[index];
    if (!target || index === ms.currentIndex) return;

    msClearArrivalCheck();

    const prevCurrent = ms.stops[ms.currentIndex];
    if (prevCurrent && prevCurrent.status === 'current') {
        prevCurrent.status = 'pending'; // demoted, not skipped — still in the list
    }

    target.status = 'current';
    ms.currentIndex = index;

    state.selectedLocation = target.location;
    state._routeRecordedThisNav = false;
    await navigateToSelected();
}

function msOpenAddStop() {
    const session = getAuthSession();
    if (!Permissions.canUseFeature(session?.role || 'VISITOR', 'multiStop')) {
        showNotification('This feature is not available for your account type.', 'error');
        return;
    }

    const modal = document.getElementById('msAddStopModal');
    modal.style.display = 'flex';
    document.getElementById('msStopSearchInput').value = '';
    document.getElementById('msStopSearchResults').innerHTML = '';
    setTimeout(() => document.getElementById('msStopSearchInput').focus(), 100);
}

function msCloseAddStop() {
    document.getElementById('msAddStopModal').style.display = 'none';
}

function msSearchStop(query) {
    const resultsDiv = document.getElementById('msStopSearchResults');
    if (!query || query.trim().length < 1) {
        resultsDiv.innerHTML = '';
        return;
    }

    const campus = campusData[state.currentCampus];
    const session = getAuthSession();
    const role = session?.role || 'VISITOR';
    // Every stop is normalized (see msNormalizeLocation) to a globally-unique
    // "building_<id>" or "room_<buildingId>_<roomId>" id, so we can compare
    // directly against the SAME id shapes we're about to build below —
    // whichever screen a stop was originally added from.
    const existing = new Set(state.multiStop.stops.map(s => s.location.id));
    const q = query.toLowerCase();
    const results = [];

// Search buildings
    let buildingsConsidered = 0, buildingsBlockedByPermission = 0, buildingsNameMatched = 0;
    campus.locations.forEach(loc => {
        buildingsConsidered++;

        let allowed = true;
        try {
            allowed = Permissions.canAccessLocationType(role, loc.type);
        } catch (err) {
            console.error('Permissions check threw for building', loc.name, err);
            allowed = true;
        }
        if (!allowed) { buildingsBlockedByPermission++; return; }

        const nameMatch = typeof loc.name === 'string' && loc.name.toLowerCase().includes(q);
        const shortMatch = typeof loc.shortName === 'string' && loc.shortName.toLowerCase().includes(q);
        if (nameMatch || shortMatch) buildingsNameMatched++;

        const buildingId = `building_${loc.id}`;
        if (!existing.has(buildingId) && (nameMatch || shortMatch)) {
            results.push({
                id: buildingId,
                name: loc.name,
                subtitle: loc.type,
                icon: '🏢',
                coords: loc.coords,
                matchType: 'building'
            });
        }

        // Search rooms inside each building
        if (loc.rooms && Array.isArray(loc.rooms)) {
            loc.rooms.forEach(room => {
                const roomId = `room_${loc.id}_${room.id}`;
                if (!existing.has(roomId) && room.name && room.name.toLowerCase().includes(q)) {
                    results.push({
                        id: roomId,
                        name: room.name,
                        subtitle: `${loc.name} — ${room.floor}`,
                        icon: '🚪',
                        coords: room.coords,
                        matchType: 'room',
                        buildingName: loc.name,
                        instructor: room.instructor || null
                    });
                }
            });
        }
    });

    console.log(`[msSearchStop] role=${role} query="${q}" buildingsConsidered=${buildingsConsidered} blockedByPermission=${buildingsBlockedByPermission} nameMatched=${buildingsNameMatched} totalResults=${results.length} buildingResults=${results.filter(r=>r.matchType==='building').length} roomResults=${results.filter(r=>r.matchType==='room').length}`);

    resultsDiv.innerHTML = results.slice(0, 10).map(item => `
        <div onclick="msAddStopDirect(${JSON.stringify(item).replace(/"/g, '&quot;')})" style="
            padding:10px 12px;
            border:1px solid #e0e0e0;
            border-radius:8px;
            cursor:pointer;
            display:flex;
            align-items:center;
            gap:10px;
            transition:background 0.2s;
            background:white;
        "
        onmouseover="this.style.background='#f0f7ff'"
        onmouseout="this.style.background='white'">
            <span style="font-size:18px;">${item.icon}</span>
            <div>
                <div style="font-weight:600; font-size:13px; color:#222;">${item.name}</div>
                <div style="font-size:11px; color:#888;">${item.subtitle}</div>
                ${item.instructor ? `<div style="font-size:11px; color:#9c27b0;">👨‍🏫 ${item.instructor}</div>` : ''}
            </div>
        </div>
    `).join('');
}

// Lets the user add ANY location (building or room) as their next multi-stop
// stop directly from the location details modal or marker popup — used when
// they're already navigating and tap something new, instead of forcing them
// back into the separate "Add Stop" search modal.
async function msAddLocationAsStop(location) {
    if (!location) return;

    // Normalize FIRST so a building straight from campusData and a room from
    // any entry point (search modal, marker popup, location modal) all end
    // up compared against the same globally-unique id scheme.
    const normalized = msNormalizeLocation(location);

    const alreadyIn = state.multiStop.stops.some(s => s.location.id === normalized.id);
    if (alreadyIn) {
        showNotification(`${normalized.name} is already in your stops`, 'info');
        return;
    }

    // Visitors must state a purpose before a stop is added.
    if (typeof window.ensureVisitPurpose === 'function') {
        document.getElementById('locationModal')?.classList.remove('active');
        const allowed = await window.ensureVisitPurpose(normalized);
        if (!allowed) return;
    }

    state.multiStop.stops.push({
        location: normalized,
        status: 'pending',
        cachedRoute: null
    });

    document.getElementById('locationModal')?.classList.remove('active');
    closeActivePopup();
    showNotification(`📍 ${normalized.name} added to your stops`, 'success');

    msReorderByDistance();
}

async function msAddStopDirect(item) {
    // item already carries a globally-unique id + matchType from msSearchStop
    // (building_<id> or room_<buildingId>_<roomId>), plus buildingName for
    // rooms — msNormalizeLocation passes it straight through unchanged.
    const location = msNormalizeLocation({
        id: item.id,
        name: item.name,
        coords: item.coords,
        matchType: item.matchType,
        buildingName: item.buildingName || null
    });

    const alreadyIn = state.multiStop.stops.some(s => s.location.id === location.id);
    if (alreadyIn) {
        msCloseAddStop();
        showNotification(`${location.name} is already in your stops`, 'info');
        return;
    }

    // Visitors must state a purpose before a stop is added.
    if (typeof window.ensureVisitPurpose === 'function') {
        msCloseAddStop();
        const allowed = await window.ensureVisitPurpose(location);
        if (!allowed) return;
    }

    state.multiStop.stops.push({
        location,
        status: 'pending',
        cachedRoute: null
    });

    msCloseAddStop();
    showNotification(`📍 ${location.name} added to your stops`, 'success');

    // Re-solves the whole remaining trip nearest-first from your real
    // location, instead of just chaining this new stop off whatever was
    // previously active — so a closer stop actually gets visited first.
    await msReorderByDistance();
}

// Legacy single-arg add-by-id (buildings only, matched by numeric campusData
// id). Kept for backward compatibility with any old call sites, but routed
// through the same normalize + dedupe path as every other entry point so it
// can't drift out of sync with msAddStopDirect / msAddLocationAsStop again.
async function msAddStop(locationId) {
    const campus = campusData[state.currentCampus];
    const location = campus.locations.find(l => l.id === locationId);
    if (!location) return;

    await msAddLocationAsStop(location);
    msCloseAddStop();
}

async function msCacheRoute(destination, stopIndex) {
    let startCoords;

    // Every leg — the active one AND every future/pending preview — starts
    // from your live GPS position. Chaining future legs off the previous
    // stop's coords looked like a bug: a line appearing to start somewhere
    // you haven't actually reached yet. This previews "how to get to this
    // stop from where I am right now," which is much clearer.
    if (state.userLocation) {
        startCoords = [state.userLocation.lat, state.userLocation.lng];
    } else {
        const campus = campusData[state.currentCampus];
        startCoords = [campus.center.lat, campus.center.lng];
    }

    const destCoords = normalizeCoords(destination.coords);
    if (!destCoords || !startCoords) return;

    // Uses the same Walk/Car/Bike selection (or 'auto' fallback) as the
    // primary route — see pickRoutingProfile().
    const msRoutingProfile = pickRoutingProfile(startCoords, destCoords);

    try {
        const route = await fetchORSRoute(startCoords, destCoords, msRoutingProfile);
        state.multiStop.stops[stopIndex].cachedRoute = {
            coordinates: route.coordinates.map(c => [c.lat, c.lng]),
            distance: route.summary.totalDistance,
            duration: route.summary.totalTime,
            profile: msRoutingProfile,
            isFallback: false
        };

        showNotification(`📥 Route to ${destination.name} cached`, 'info');

    } catch (err) {
        // Fallback straight line
        state.multiStop.stops[stopIndex].cachedRoute = {
            coordinates: [startCoords, destCoords],
            distance: calculateDistance(startCoords, destCoords),
            duration: calculateDistance(startCoords, destCoords) / 1.4,
            isFallback: true
        };
    }

    msRenderProgress();
}

// Nearest-neighbor multi-stop optimizer. Every time the stop list changes
// (add or remove), this re-solves the ENTIRE remaining trip: starting from
// your real live location, it greedily picks whichever not-yet-visited stop
// is closest, then chains onward from there, closest-next, until every stop
// has a position. This is a fast approximation (not a guaranteed-optimal
// TSP solve) but for the handful of stops a campus trip realistically has,
// it reliably avoids situations like "closer building queued behind a far
// one" — every leg's start point is either your real GPS position (for the
// first leg) or wherever the previous leg in the new order actually ends.
// Recomputes statuses/cached routes for the remaining (non-done) stops
// WITHOUT changing their order. Stops always stay in the exact sequence
// they were added in — "Add Next Stop" appends to the end, and that's
// where it stays. (This used to greedily re-sort every remaining stop by
// nearest-distance-first on every add/remove, which is why the visible
// order didn't match the order things were added in.)
async function msReorderByDistance() {
    const ms = state.multiStop;
    if (!ms.active) return;

    const doneStops = ms.stops.filter(s => s.status === 'done');
    const remaining = ms.stops.filter(s => s.status !== 'done');
    if (remaining.length === 0) return;

    const previousCurrentId = ms.stops[ms.currentIndex]?.location?.id;

    // Keep `remaining` in its existing array order — that IS insertion
    // order, since new stops are always pushed onto the end of ms.stops.
    remaining.forEach((stop, i) => {
        stop.cachedRoute = null; // stale — the chain around it may have changed
        stop.status = i === 0 ? 'current' : 'pending';
    });

    ms.stops = [...doneStops, ...remaining];
    ms.currentIndex = doneStops.length;

    // Re-cache every non-done leg against its (possibly new) position in
    // the chain. msCacheRoute() already falls back to your live location
    // when a stop has no predecessor, which is exactly what the first
    // remaining leg needs.
    for (let i = doneStops.length; i < ms.stops.length; i++) {
        await msCacheRoute(ms.stops[i].location, i);
    }

    const newCurrent = ms.stops[ms.currentIndex];
    if (newCurrent && newCurrent.location.id !== previousCurrentId) {
        // The active leg itself changed — actually switch the on-screen
        // route (2D + 3D), not just the cache, same as msJumpToStop.
        msClearArrivalCheck();
        state.selectedLocation = newCurrent.location;
        state._routeRecordedThisNav = false;
        await navigateToSelected();
    } else {
        msRenderProgress();
    }
}

async function msRemoveStop(index) {
    if (state.multiStop.stops[index]?.status === 'current') return;
    state.multiStop.stops.splice(index, 1);
    showNotification('Stop removed', 'info');
    await msReorderByDistance();
}

function msStartArrivalCheck(destination) {
    msClearArrivalCheck();

    const THRESHOLD = 25;
    const destCoords = normalizeCoords(destination.coords);
    if (!destCoords) return;

    state.multiStop.arrivalChecker = setInterval(() => {
        if (!state.userLocation) return;

        const userCoords = [state.userLocation.lat, state.userLocation.lng];
        const distance = calculateDistance(userCoords, destCoords);

        // Show arrived button when within 50m
        const arrivedSection = document.getElementById('msArrivedSection');
        if (arrivedSection) {
            arrivedSection.style.display = distance <= 50 ? 'block' : 'none';
        }

        // Trigger countdown when within 25m
        if (distance <= THRESHOLD) {
            msClearArrivalCheck();
            msStartCountdown();
        }

    }, 3000);
}

function msClearArrivalCheck() {
    if (state.multiStop.arrivalChecker) {
        clearInterval(state.multiStop.arrivalChecker);
        state.multiStop.arrivalChecker = null;
    }
    if (state.multiStop.countdownTimer) {
        clearInterval(state.multiStop.countdownTimer);
        state.multiStop.countdownTimer = null;
    }
}

function msStartCountdown() {
    let seconds = 5;
    const banner = document.getElementById('msCountdownBanner');
    const arrivedSection = document.getElementById('msArrivedSection');

    if (!banner) return;

    arrivedSection.style.display = 'block';
    banner.style.display = 'block';

    const nextStop = state.multiStop.stops[state.multiStop.currentIndex + 1];
    const nextName = nextStop ? nextStop.location.name : null;

    const update = () => {
        banner.innerHTML = `
            <div>You have arrived!</div>
            <div style="font-size:18px; margin:4px 0;">${seconds}s</div>
            ${nextName ? `<div style="font-size:11px; opacity:0.8;">Switching to ${nextName}...</div>` : ''}
            <button onclick="msCancelCountdown()" style="
                margin-top:6px;
                background:rgba(255,255,255,0.2);
                border:1px solid rgba(255,255,255,0.4);
                color:white;
                padding:4px 12px;
                border-radius:6px;
                font-size:11px;
                cursor:pointer;
            ">Cancel</button>
        `;
    };

    update();

    state.multiStop.countdownTimer = setInterval(() => {
        seconds--;
        if (seconds <= 0) {
            clearInterval(state.multiStop.countdownTimer);
            state.multiStop.countdownTimer = null;
            banner.style.display = 'none';
            msArrived();
        } else {
            update();
        }
    }, 1000);
}

function msCancelCountdown() {
    if (state.multiStop.countdownTimer) {
        clearInterval(state.multiStop.countdownTimer);
        state.multiStop.countdownTimer = null;
    }
    document.getElementById('msCountdownBanner').style.display = 'none';
    showNotification('Auto-switch cancelled — tap Arrived when ready', 'info');
}

async function msArrived() {
    const ms = state.multiStop;
    msClearArrivalCheck();

    const arrivedStop = ms.stops[ms.currentIndex];

    // Mark current stop as done
    arrivedStop.status = 'done';

    ms.currentIndex++;

    // Check if there are more stops
    if (ms.currentIndex >= ms.stops.length) {
        showNotification('🎉 You have reached your final destination!', 'success');
        document.getElementById('msArrivedSection').style.display = 'none';
        msRenderProgress();
        return;
    }

    // Move to next stop
    const nextStop = ms.stops[ms.currentIndex];
    nextStop.status = 'current';
    ms.active = true;

    msRenderProgress();
    showNotification(`🧭 Navigating to ${nextStop.location.name}`, 'info');

    // Check if online or offline
    if (!navigator.onLine && nextStop.cachedRoute) {
        // Use cached route
        document.getElementById('msOfflineBanner').style.display = 'block';
        msDrawCachedRoute(nextStop);
    } else {
        // Navigate normally
        document.getElementById('msOfflineBanner').style.display = 'none';
        state.selectedLocation = nextStop.location;
        state._routeRecordedThisNav = false; // ✅ Reset for each stop
        await navigateToSelected();
    }
}

async function msDrawCachedRoute(stop) {
    clearRoute();

    const cached = stop.cachedRoute;
    const coords = cached.coordinates;

    // cached.coordinates is stored as [lat, lng] pairs (see the OSRM fetch
    // that builds it) — drawRouteLine/addAnimatedOverlay expect {lat, lng}
    // objects, same shape used everywhere else in the route pipeline.
    const coordObjs = coords.map(c => ({ lat: c[0], lng: c[1] }));

    const routeColor = cached.isFallback ? '#ea4335' : '#2c5aa0';
    drawRouteLine(coordObjs, routeColor);       // also handles fitBounds
    addAnimatedOverlay(coordObjs);

    if (state.userLocation) {
        addStartDottedLine([state.userLocation.lat, state.userLocation.lng], coordObjs);
    }

    state.currentRoute = {
        coordinates: coordObjs,
        distance: cached.distance,
        duration: cached.duration,
        instructions: [],
        // ✅ Same pinning as navigateToSelected() — see comment there.
        destination: stop.location
    };

    if (map3dState.active && map3dState.map) {
        sync3DRoute();
    }

    // Show route info
    const distanceM = Math.round(cached.distance);
    const timeMin = Math.ceil(cached.duration / 60);
    const modeInfo = getTravelModeLabel(cached.profile);
    const routeInfo = document.getElementById('routeInfo');
    const details = document.getElementById('routeDetails');

    details.innerHTML = `
        <div class="route-summary">
            <div class="route-stat" style="border-left-color:#2c5aa0;">
                <strong>📏 Distance:</strong> ${distanceM < 1000 ? distanceM + ' m' : (distanceM/1000).toFixed(2) + ' km'}
            </div>
            <div class="route-stat" style="border-left-color:#2c5aa0;">
                <strong>${modeInfo.icon} ${modeInfo.label}:</strong> ${timeMin} min
            </div>
            <div class="route-stat" style="border-left-color:#2c5aa0;">
                <strong>📍 Destination:</strong> ${stop.location.name}
            </div>
        </div>
        ${cached.isFallback ? `
        <p style="color:#ea4335; font-size:13px; padding:10px; background:#fee; border-radius:6px; margin-top:8px;">
            ⚠️ Showing direct path — offline mode.
        </p>` : ''}
    `;

    routeInfo.classList.remove('hidden');
    msStartArrivalCheck(stop.location);

    // ✅ Record cached route in DB
    state._routeRecordedThisNav = false;
    const session = getAuthSession();
    if (session?.userId) {
        try {
            await fetch('/api/routes/record', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId:      session.userId,
                    destination: stop.location.name || 'Unknown',
                    distance:    Math.round(Number(cached.distance) || 0),
                    duration:    Math.round(Number(cached.duration) || 0),
                    isRoom:      stop.location.matchType === 'room',
                    campus:      state.currentCampus || 'iba'
                })
            });
        } catch (e) {
            console.warn('Could not record cached route:', e);
        }
    }
}

// ✅ Monitor online/offline
window.addEventListener('online', () => {
    document.getElementById('msOfflineBanner').style.display = 'none';
    showNotification('✅ Back online!', 'success');
});

window.addEventListener('offline', () => {
    document.getElementById('msOfflineBanner').style.display = 'block';
    showNotification('📵 Offline — cached routes still available', 'warning');
});


function showSavedLocations() {
    if (state.savedLocations.length === 0) {
        showNotification('No saved locations yet!');
        return;
    }
    
    const resultsDiv = document.getElementById('searchResults');
    resultsDiv.innerHTML = '<div class="search-result-item" style="font-weight: bold; background: #f0f7ff;">⭐ Saved Locations</div>';
    
    state.savedLocations.forEach(loc => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.innerHTML = `
            <span class="result-name">${loc.name}</span>
            <span class="result-type">${loc.type}</span>
        `;
        item.addEventListener('click', () => {
            showLocationDetails(loc);
            state.map.jumpTo({ center: [loc.coords[1], loc.coords[0]], zoom: 18 });
            resultsDiv.classList.add('hidden');
        });
        resultsDiv.appendChild(item);
    });
    
    resultsDiv.classList.remove('hidden');
}

// ══════════════════════════════════════════
// 👤 USER PROFILE PANEL
// ══════════════════════════════════════════

async function openProfilePanel() {
    const session = getAuthSession();
    if (!session) return;
    const isVisitor = (session.role || 'VISITOR') === 'VISITOR';
    // Every role (including Visitors, who now have real accounts) can set a
    // profile picture. Reset to visible in case an earlier session hid it.
    const photoEditLabel = document.querySelector('label[for="profilePhotoInput"]');
    if (photoEditLabel) photoEditLabel.style.display = 'flex';
    // Driven by the role's routeHistory flag in permissions.js, so this stays
    // in sync if the rule ever changes again, instead of hardcoding a role.
    const activitySection = document.getElementById('profileActivitySection');
    const canSeeRouteHistory = window.Permissions?.canUseFeature(session.role, 'routeHistory');
    if (activitySection) activitySection.style.display = canSeeRouteHistory ? '' : 'none';

    const existingPanel = document.getElementById('profilePanel');
    if (existingPanel && existingPanel.classList.contains('open')) return;

    let extras = profileGetExtras(session.userId);

    try {
        const res = await fetch(`/api/auth/profile/${session.userId}`);
        const data = await res.json();
        if (res.ok && data.ok) {
            const u = data.user;
            session.name  = u.name  || session.name;
            session.email = u.email || session.email;
            setAuthSession(session);
            if (u.phone) extras.phone = u.phone;
            if (u.photo) extras.photo = u.photo;
            profileSaveExtras(session.userId, extras);
        }
    } catch (e) {
        console.warn('Could not load profile from DB, using cached data');
    }

    document.getElementById('profileHeaderName').textContent = session.name || '—';
    document.getElementById('profileHeaderRole').textContent =
        (session.role || 'user').charAt(0).toUpperCase() + (session.role || 'user').slice(1);
    document.getElementById('profileHeaderId').textContent = 'ID: ' + (session.userId || '—');

    document.getElementById('infoName').textContent   = session.name  || '—';
    document.getElementById('infoEmail').textContent  = session.email || '—';
    document.getElementById('infoRole').textContent   =
        (session.role || 'user').charAt(0).toUpperCase() + (session.role || 'user').slice(1);
    document.getElementById('infoUserId').textContent = session.userId || '—';
    document.getElementById('infoRoutes').textContent = (state.routeHistory || []).length;

    // ✅ Load accurate count from DB
    const session2 = getAuthSession();
    if (session2?.userId) {
        fetch(`/api/routes/count/${session2.userId}`)
            .then(r => r.json())
            .then(d => {
                if (d.ok) {
                    document.getElementById('infoRoutes').textContent = d.total;
                }
            })
            .catch(() => {});
    }

    profileRenderAvatar(session.name, extras.photo);

    const panel = document.getElementById('profilePanel');
    document.getElementById('profilePanelOverlay').style.display = 'block';
    panel.style.display = 'flex';

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            panel.classList.add('open');
        });
    });
}

function closeProfilePanel() {
    const panel = document.getElementById('profilePanel');
    const overlay = document.getElementById('profilePanelOverlay');

    panel.classList.remove('open');

    const hide = () => {
        panel.style.display = 'none';
        overlay.style.display = 'none';
        panel.removeEventListener('transitionend', onTransitionEnd);
    };

    function onTransitionEnd(e) {
        if (e.target === panel && e.propertyName === 'transform') hide();
    }
    panel.addEventListener('transitionend', onTransitionEnd);
    setTimeout(hide, 400);
}

function profileRenderAvatar(name, photoDataUrl) {
    const el = document.getElementById('profileAvatarDisplay');
    const chip = document.getElementById('profileChipBtn').querySelector('.chip-avatar');

    if (photoDataUrl) {
        // Profile panel avatar
        el.innerHTML = `<img src="${photoDataUrl}" style="width:100%;height:100%;object-fit:cover;">`;

        // ✅ Header chip — show the photo
        chip.style.background = 'transparent';
        chip.style.padding = '0';
        chip.style.overflow = 'hidden';
        chip.innerHTML = `<img src="${photoDataUrl}" style="width:20px;height:20px;object-fit:cover;border-radius:50%;display:block;">`;
    } else {
        // Profile panel avatar — initials fallback
        const initials = (name || '?').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
        el.textContent = initials;

        // ✅ Header chip — back to default emoji
        chip.style.background = '#f0a500';
        chip.style.padding = '';
        chip.style.overflow = '';
        chip.innerHTML = '👤';
    }
}

function profileHandlePhoto(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
        showNotification('Photo must be under 2MB', 'error');
        return;
    }
    const reader = new FileReader();
    reader.onload = async (e) => {
        const dataUrl = e.target.result;

        // ✅ Resize + crop to a clean 300x300 square before saving
        const img = new Image();
        img.onload = async () => {
            const canvas = document.createElement('canvas');
            const size = 300;
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');

            // Crop to square from center
            const minSide = Math.min(img.width, img.height);
            const sx = (img.width - minSide) / 2;
            const sy = (img.height - minSide) / 2;
            ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);

            const resizedDataUrl = canvas.toDataURL('image/jpeg', 0.7);

            const session = getAuthSession();
            if (!session) return;

            try {
                const res = await fetch('/api/auth/update-photo', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: session.userId, photo: resizedDataUrl })
                });
                const data = await res.json();
                if (!res.ok || !data.ok) {
                    showNotification(data.error || 'Photo save failed', 'error');
                } else {
                    showNotification('Profile photo updated!', 'success');
                }
            } catch (err) {
                showNotification('Server unreachable. Photo saved locally only.', 'error');
            }

            const extras = profileGetExtras(session.userId);
            extras.photo = resizedDataUrl;
            profileSaveExtras(session.userId, extras);
            profileRenderAvatar(session.name, resizedDataUrl);
        };
        img.src = dataUrl;
    };
    reader.readAsDataURL(file);
}

// Extras storage (phone, photo) keyed by userId
function profileGetExtras(userId) {
    try {
        return JSON.parse(localStorage.getItem('profileExtras_' + userId)) || {};
    } catch { return {}; }
}
function profileSaveExtras(userId, data) {
    localStorage.setItem('profileExtras_' + userId, JSON.stringify(data));
}

// Close panel on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeProfilePanel();
});

// ══════════════════════════════════════════
// 🌐 MAPLIBRE 3D MAP TOGGLE
// ══════════════════════════════════════════

const map3dState = {
    map: null,
    active: false,
    markersAdded: false,
    markers: [],
    userMarker: null, // ✅ the 3D counterpart of state.userMarker (2D)
    dashAnimationFrame: null, // ← ADD 
    dashStep: -1,
    paleLayerIds: []  // multi-stop "other stops" preview lines on the 3D map
};

function toggle3DMap() {
    if (map3dState.active) {
        exit3DMap();
    } else {
        enter3DMap();
    }
}

function enter3DMap() {
    const campus = campusData[state.currentCampus];
    const btn = document.getElementById('toggle3dBtn'); // now optional, may be null

    const mapCenter = state.map.getCenter();
    const mapZoom   = state.map.getZoom();
    const mlZoom = Math.max(mapZoom - 1, 14);

    document.getElementById('map').style.display = 'none';
    document.getElementById('map3d').style.display = 'block';
    document.getElementById('map').setAttribute('aria-hidden', 'true');
    document.getElementById('map3d').setAttribute('aria-hidden', 'false');

    if (btn) {
        btn.textContent = '2D';
        btn.style.background = '#2c5aa0';
        btn.style.color = 'white';
    }

    map3dState.active = true;

    // Init MapLibre if not already
    if (!map3dState.map) {
        map3dState.map = new maplibregl.Map({
            container: 'map3d',
            // Standard OpenStreetMap raster tiles as the ground — same base
            // map as the 2D view. 3D buildings are drawn from their own
            // GeoJSON fill-extrusion source (add3DBuildingLayer, etc.), not
            // from the basemap, so a raster ground works fine here too.
            style: {
                version: 8,
                sources: {
                    'osm-standard-3d': {
                        type: 'raster',
                        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                        tileSize: 256,
                        maxzoom: 19,
                        attribution: '© OpenStreetMap contributors'
                    }
                },
                layers: [
                    {
                        id: 'osm-standard-3d-layer',
                        type: 'raster',
                        source: 'osm-standard-3d'
                    }
                ]
            },
            center: [mapCenter.lng, mapCenter.lat],
            zoom: mlZoom,
            pitch: 65,
            maxPitch: 75,
            bearing: 0,
            antialias: true,
            pitchWithRotate: false,
            touchPitch: false   
        });

        map3dState.map.addControl(new maplibregl.NavigationControl({
            showCompass: true,
            showZoom: true,
            visualizePitch: true
        }), 'top-right');
        wireHeadingToMapBearing(map3dState.map); // keep the beam locked to true north as the map rotates

        map3dState.map.on('load', () => {
            map3dState.baseStyleLayerIds = map3dState.map.getStyle().layers.map(l => l.id);

            // Satellite raster layer for the 3D ground, toggled together
            // with the 2D map via switchMapStyle('satellite'). No beforeId
            // needed — add3DBuildingLayer() below adds the extrusions after
            // both raster layers regardless, so they always render on top.
            map3dState.map.addSource('osm-satellite-3d', {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                maxzoom: 17,
                attribution: '© Esri, Maxar, Earthstar Geographics'
            });
            map3dState.map.addLayer({
                id: 'tile-satellite-3d',
                type: 'raster',
                source: 'osm-satellite-3d',
                layout: { visibility: window.currentMapStyle === 'satellite' ? 'visible' : 'none' }
            });

            add3DBuildingLayer();
            addDynamicBuildingFootprints3D();
            add3DTrees();
            add3DCampusBoundary();
            add3DMarkers();
            sync3DRoute();
            if (state.userLocation) {
                sync3DUserLocationMarker(state.userLocation.lat, state.userLocation.lng);
            }
        });
    } else {
        // Re-entering 3D mode with a map that already exists — fly back to
        // the current 2D center at the standard pitch (no need to pass
        // pitch here, flyTo just keeps the map's existing pitch if omitted,
        // and we don't want to fight the 65° default with a stray 85°).
        map3dState.map.flyTo({
            center: [mapCenter.lng, mapCenter.lat],
            zoom: mlZoom,
            pitch: 65,
            duration: 800
        });

        // ✅ The container was `display:none` while the 2D map was showing.
        // MapLibre caches canvas dimensions internally and does NOT notice
        // when its container's size changes (or was 0x0) while hidden —
        // without an explicit resize(), map.project() keeps using the stale
        // size to position marker DOM elements, so building labels visually
        // render in one spot (the canvas just stretches to fit) while their
        // actual clickable element drifts somewhere else. This is why
        // labels looked unresponsive after the first 2D↔3D switch.
        map3dState.map.resize();

        addDynamicBuildingFootprints3D();
        add3DTrees();
        add3DMarkers();
        sync3DRoute();
        if (state.userLocation) {
            sync3DUserLocationMarker(state.userLocation.lat, state.userLocation.lng);
        }
    }
}

function exit3DMap() {
    clear3DRoute();
    const btn = document.getElementById('toggle3dBtn'); // now optional, may be null

    if (map3dState.map) {
        const mlCenter = map3dState.map.getCenter();
        const mlZoom   = map3dState.map.getZoom();
        state.map.jumpTo({ center: [mlCenter.lng, mlCenter.lat], zoom: mlZoom + 1 });
    }

    document.getElementById('map').style.display = 'block';
    document.getElementById('map3d').style.display = 'none';
    document.getElementById('map').setAttribute('aria-hidden', 'false');
    document.getElementById('map3d').setAttribute('aria-hidden', 'true');

    if (btn) {
        btn.textContent = '3D';
        btn.style.background = '';
        btn.style.color = '';
    }

    map3dState.active = false;

    // Resize the map in case the container changed while 3D mode was active
    // (invalidateSize() was Leaflet-only and doesn't exist on a MapLibre map — this is the fix)
    setTimeout(() => state.map.resize(), 100);
    
    // Re-sync footprint style with current 2D map style (MapLibre GeoJSON layers)
    if (state.map && state.map.getLayer('building-footprints-fill')) {
        switchMapStyle(window.currentMapStyle || 'default');
    }
}


function addDynamicBuildingFootprints3D() {
    const ml = map3dState.map;
    const campus = campusData[state.currentCampus];
    if (!ml || !campus) return;

    updateBuildings3DCampusFilter();

    updateBuildings3DCampusFilter();

    const typeColors = {
        administration: '#2c5aa0',
        department:     '#34a853',
        facilities:     '#fbbc04',
        office:         '#ea4335',
        landmark:       '#9c27b0'
    };

    const features = (campus.locations || [])
        .filter(loc => Array.isArray(loc.footprint) && loc.footprint.length >= 3)
        .map(loc => {
            const ring = loc.footprint.map(p => [p[1], p[0]]);
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) {
                ring.push([first[0], first[1]]);
            }

            return {
                type: 'Feature',
                properties: {
                    name: loc.name,
                    color: typeColors[loc.type] || '#000000',
                    height: Number(loc.footprintHeight) || 4
                },
                geometry: {
                    type: 'Polygon',
                    coordinates: [ring]
                }
            };
        });

    if (!features.length) return;

    if (ml.getSource('dynamic-building-footprints')) {
        ml.getSource('dynamic-building-footprints').setData({ type: 'FeatureCollection', features });
        return;
    }

    ml.addSource('dynamic-building-footprints', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features }
    });

    ml.addLayer({
        id: 'dynamic-building-footprints-fill',
        type: 'fill',
        source: 'dynamic-building-footprints',
        paint: { 'fill-color': '#aaaaaa', 'fill-opacity': 0.3 }
    });

    ml.addLayer({
        id: 'dynamic-building-footprints-outline',
        type: 'line',
        source: 'dynamic-building-footprints',
        paint: { 'line-color': '#000000', 'line-width': 1.5 }
    });

    ml.addLayer({
        id: 'dynamic-building-footprints-3d',
        type: 'fill-extrusion',
        source: 'dynamic-building-footprints',
        paint: {
            'fill-extrusion-color': '#aaaaaa',
            'fill-extrusion-height': ['*', ['get', 'height'], 2],
            'fill-extrusion-base': 0,
            'fill-extrusion-opacity': 0.65
        }
    });
}

// Deterministic pseudo-random generator seeded by the tree's own id, so
// each tree's canopy shape is stable across reloads/resyncs instead of
// reshuffling every time add3DTrees() re-runs.
function seededRandom(seed) {
    let t = seed;
    return function () {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

// Same as createAccuracyCircleGeoJSON but with per-vertex radius jitter,
// so the outline reads as an irregular clump of leaves instead of a
// perfect circle. Reuses the same earthRadius/latRad math for consistency
// with the rest of the file's circle-generation code.
function irregularCircleGeoJSON(lng, lat, radiusMeters, points, rng) {
    const earthRadius = 6371000;
    const latRad = (lat * Math.PI) / 180;
    const jitters = [];
    for (let i = 0; i < points; i++) jitters.push(0.75 + rng() * 0.5);

    const coords = [];
    for (let i = 0; i <= points; i++) {
        const angle = (i / points) * 2 * Math.PI;
        const r = radiusMeters * jitters[i % points];
        const dx = r * Math.cos(angle);
        const dy = r * Math.sin(angle);
        const dLat = dy / earthRadius;
        const dLng = dx / (earthRadius * Math.cos(latRad));
        coords.push([lng + (dLng * 180) / Math.PI, lat + (dLat * 180) / Math.PI]);
    }

    return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [coords] }
    };
}

const CANOPY_GREENS = ['#2e7d32', '#388e3c', '#1b5e20', '#43a047'];

// Builds a tree's canopy as tiers stacked from base to top, where each
// tier's radius follows a sine curve (0 at the very base and very top,
// widest in the middle) — a rounded dome/ellipsoid silhouette sitting on
// the trunk, instead of a single flat-topped cylinder. Each tier is made
// of several jittered puffs so the outline stays leafy/irregular rather
// than a smooth balloon. `base`/`top` are absolute heights (matching this
// file's existing convention — `top` is stored in the `height` property
// consumed by the fill-extrusion layer's 'fill-extrusion-height').
function buildCanopyPuffs(tree, lat, lng, radius, base, top) {
    const rng = seededRandom(Number(tree.id) || 1);
    const totalHeight = Math.max(top - base, 0.5);
    const TIERS = 5;
    const puffs = [];

    for (let tier = 0; tier < TIERS; tier++) {
        const t0 = tier / TIERS;
        const t1 = (tier + 1) / TIERS;
        const tMid = (t0 + t1) / 2;

        const tierRadius = radius * Math.sin(tMid * Math.PI) * (0.9 + rng() * 0.2);
        const tierBase = base + totalHeight * t0;
        const tierTop = base + totalHeight * t1 + totalHeight * 0.08; // slight overlap between tiers

        const puffCount = tier === 0 || tier === TIERS - 1 ? 2 : 3 + Math.floor(rng() * 2);

        for (let i = 0; i < puffCount; i++) {
            const angle = (i / puffCount) * Math.PI * 2 + rng() * 0.6;
            const dist = tierRadius * (0.3 + rng() * 0.35);
            const dLat = (dist * Math.sin(angle)) / 111320;
            const dLng = (dist * Math.cos(angle)) / (111320 * Math.cos(lat * Math.PI / 180));
            puffs.push({
                lat: lat + dLat,
                lng: lng + dLng,
                radius: Math.max(tierRadius * (0.45 + rng() * 0.3), 0.3),
                base: tierBase,
                top: tierTop,
                color: CANOPY_GREENS[Math.floor(rng() * CANOPY_GREENS.length)]
            });
        }
    }

    // One extra puff dead center at the very top to close off the crown
    // instead of leaving a visible gap where the last tier tapers to zero.
    puffs.push({
        lat, lng,
        radius: radius * 0.25,
        base: base + totalHeight * 0.82,
        top: top,
        color: CANOPY_GREENS[Math.floor(rng() * CANOPY_GREENS.length)]
    });

    return puffs.map(p => {
        const feature = irregularCircleGeoJSON(p.lng, p.lat, p.radius, 7, rng);
        feature.properties = { base: p.base, height: p.top, color: p.color };
        return feature;
    });
}

function add3DTrees() {
    const ml = map3dState.map;
    if (!ml || !Array.isArray(state.trees) || !state.trees.length) return;
    const TRUNK_COLOR = '#6b4423';
    const trunkFeatures = [], canopyFeatures = [];
    state.trees.forEach(tree => {
        const lat = Number(tree.lat), lng = Number(tree.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        const trunkHeight = Number(tree.trunk_height) || 2;
        const canopyHeight = Number(tree.canopy_height) || trunkHeight + 3;
        const canopyRadius = Number(tree.canopy_radius) || 1.5;
        const trunkRadius = Math.max(0.25, canopyRadius * 0.15);

        // ✅ Root flare: a short, wider disk at ground level beneath the
        // main trunk shaft, so the base visibly spreads into the ground
        // instead of looking like a rigid pole planted straight down.
        const flareHeight = Math.min(0.4, trunkHeight * 0.15);
        const flarePoly = createAccuracyCircleGeoJSON(lng, lat, trunkRadius * 1.6, 8);
        flarePoly.properties = { base: 0, height: flareHeight };
        trunkFeatures.push(flarePoly);

        const trunkPoly = createAccuracyCircleGeoJSON(lng, lat, trunkRadius, 12);
        trunkPoly.properties = { base: flareHeight, height: trunkHeight };
        trunkFeatures.push(trunkPoly);

        // Tiered-dome canopy: replaces the old single flat-topped cylinder
        // with a cluster of jittered puffs tapering toward both the trunk
        // junction and the crown, per tree.trunk_height/canopy_height/
        // canopy_radius — the exact same DB fields the Admin Dashboard's
        // tree form already edits, so no schema or admin changes needed.
        canopyFeatures.push(...buildCanopyPuffs(tree, lat, lng, canopyRadius, trunkHeight, canopyHeight));
    });
    const trunkFC = { type: 'FeatureCollection', features: trunkFeatures };
    const canopyFC = { type: 'FeatureCollection', features: canopyFeatures };
    if (ml.getSource('trees-trunks')) {
        ml.getSource('trees-trunks').setData(trunkFC);
        ml.getSource('trees-canopies').setData(canopyFC);
        return;
    }
    ml.addSource('trees-trunks', { type: 'geojson', data: trunkFC });
    ml.addSource('trees-canopies', { type: 'geojson', data: canopyFC });
    ml.addLayer({
        id: 'trees-trunks-3d',
        type: 'fill-extrusion',
        source: 'trees-trunks',
        paint: {
            'fill-extrusion-color': TRUNK_COLOR,
            'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-base': ['get', 'base'],
            'fill-extrusion-opacity': 1,
            'fill-extrusion-vertical-gradient': true
        }
    });
    ml.addLayer({
        id: 'trees-canopies-3d',
        type: 'fill-extrusion',
        source: 'trees-canopies',
        paint: {
            // ✅ Each puff carries its own randomized-but-deterministic
            // color (see CANOPY_GREENS in buildCanopyPuffs) instead of one
            // flat color for the whole canopy.
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-base': ['get', 'base'],
            'fill-extrusion-opacity': 0.95,
            'fill-extrusion-vertical-gradient': true
        }
    });
}

// Excludes OpenFreeMap/OSM buildings that fall inside the current campus's
// boundary, so they never overlap/z-fight with our own admin-drawn
// dynamic-building-footprints-3d layer. Buildings OUTSIDE the boundary
// (surrounding streets/city context) still render normally from OpenFreeMap.
// Called both right after the layer is created and every time the dynamic
// footprints refresh (resync, campus switch) so it stays correct.
function updateBuildings3DCampusFilter() {
    const ml = map3dState.map;
    const campus = campusData[state.currentCampus];
    if (!ml || !ml.getLayer('building-3d')) return;

    if (!campus?.boundary || campus.boundary.length < 3) {
        // No boundary defined for this campus — don't filter anything out.
        ml.setFilter('building-3d', null);
        return;
    }

    // campus.boundary is stored as [lat, lng] pairs — GeoJSON needs [lng, lat].
    const ring = campus.boundary.map(([lat, lng]) => [lng, lat]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
        ring.push([first[0], first[1]]);
    }

    ml.setFilter('building-3d', [
        '!',
        ['within', { type: 'Polygon', coordinates: [ring] }]
    ]);
}

function add3DBuildingLayer() {
    const ml = map3dState.map;

    if (ml.getLayer('building-3d')) {
        ml.setPaintProperty('building-3d', 'fill-extrusion-opacity', 0.65);
    }

    updateBuildings3DCampusFilter();

    // ── ALL BUILDING FOOTPRINTS ──
    // Read static footprints from the single source of truth so the 3D map
    // stays in sync with static-footprints.js automatically — no more
    // duplicate hardcoded copies that can drift out of sync with the 2D map.
    const staticFPs = (window.STATIC_BUILDING_FOOTPRINTS || []).map(fp => ({
        type: 'Feature',
        properties: { name: fp.name, height: 4, color: '#aaaaaa' },
        geometry: {
            type: 'Polygon',
            coordinates: [fp.coords.map(([lat, lng]) => [lng, lat])]
        }
    }));

    ml.addSource('building-footprints', {
        type: 'geojson',
        data: {
            type: 'FeatureCollection',
            features: [
                ...staticFPs,
                // ✅ NEW BUILDING (your uploaded GeoJSON, [lng, lat] — no conversion needed here)
                {
                    type: 'Feature',
                    properties: { name: 'New Building', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9839472, 15.3173787],
                            [119.9840524, 15.3172786],
                            [119.9843723, 15.3176078],
                            [119.9842647, 15.3177089],
                            [119.9839472, 15.3173787]
                        ]]
                    }
                },
                {
                    type: 'Feature',
                    properties: { name: 'New Building', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9818858, 15.3177853],
                            [119.9819593, 15.3178525],
                            [119.9817904, 15.3180204],
                            [119.9817195, 15.3179582],
                            [119.9818858, 15.3177853]
                        ]]
                    }
                },
                // ── GYMNASIUM ──
                {
                    type: 'Feature',
                    properties: { name: 'Gymnasium', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.982116,  15.3184361],
                            [119.9821225, 15.3179017],
                            [119.9824451, 15.3179054],
                            [119.9824374, 15.3184384],
                            [119.9822026, 15.3184367],
                            [119.9822018, 15.3184367],
                            [119.982116,  15.3184361]
                        ]]
                    }
                },
                // ── SCIENCE AND ENGINEERING LAB ──
                {
                    type: 'Feature',
                    properties: { name: 'Science and Engineering Laboratory Building', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9818506, 15.3191053],
                            [119.9817965, 15.3182924],
                            [119.9818901, 15.3182868],
                            [119.9819159, 15.3186741],
                            [119.9819372, 15.3186735],
                            [119.9819451, 15.3187909],
                            [119.9819251, 15.3187933],
                            [119.9819427, 15.3190984],
                            [119.9818506, 15.3191053]
                        ]]
                    }
                },
                // ── BATCH 1 (features 1-15) ──
                // 1. CBAPA - Department
                {
                    type: 'Feature',
                    properties: { name: 'CBAPA', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9821487, 15.3192893],
                            [119.982439,  15.3192282],
                            [119.9824137, 15.3191117],
                            [119.9821309, 15.3191699],
                            [119.9821487, 15.3192893]
                        ]]
                    }
                },
                // 2. ROTC - Office
                {
                    type: 'Feature',
                    properties: { name: 'ROTC Office', height: 4, color: '#ea4335' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9825616, 15.3191816],
                            [119.9827347, 15.3191537],
                            [119.9827159, 15.3190707],
                            [119.9825454, 15.3190989],
                            [119.9825616, 15.3191816]
                        ]]
                    }
                },
                // 3. LAW - Department
                {
                    type: 'Feature',
                    properties: { name: 'Law Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9828111, 15.319193],
                            [119.9827834, 15.319059],
                            [119.9831806, 15.3189786],
                            [119.9832069, 15.3191123],
                            [119.9828111, 15.319193]
                        ]]
                    }
                },
                // 4. DRAFTING - Department
                {
                    type: 'Feature',
                    properties: { name: 'Drafting Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9833419, 15.3190212],
                            [119.9833893, 15.3190772],
                            [119.9835677, 15.3189392],
                            [119.983524,  15.3188843],
                            [119.9833419, 15.3190212]
                        ]]
                    }
                },
                // 5. GRADUATE SCHOOL - Department
                {
                    type: 'Feature',
                    properties: { name: 'Graduate School', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9835549, 15.3188026],
                            [119.9836458, 15.3187365],
                            [119.9838618, 15.3190115],
                            [119.9837745, 15.3190735],
                            [119.9835549, 15.3188026]
                        ]]
                    }
                },
                // 6. SSQAB - Office
                {
                    type: 'Feature',
                    properties: { name: 'SSQAB Office', height: 4, color: '#ea4335' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9837626, 15.3191706],
                            [119.9838966, 15.3190765],
                            [119.9840835, 15.3193225],
                            [119.9839549, 15.3194155],
                            [119.9837626, 15.3191706]
                        ]]
                    }
                },
                // 7. GAD CENTER - Office
                {
                    type: 'Feature',
                    properties: { name: 'GAD Center', height: 4, color: '#ea4335' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9841456, 15.3196912],
                            [119.9842808, 15.3195929],
                            [119.9841481, 15.3194181],
                            [119.9840117, 15.3195163],
                            [119.9841456, 15.3196912]
                        ]]
                    }
                },
                // 8. THM - Department
                {
                    type: 'Feature',
                    properties: { name: 'THM Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9837241, 15.3197584],
                            [119.9839716, 15.3198617],
                            [119.9840433, 15.3197016],
                            [119.9839787, 15.3196744],
                            [119.9839961, 15.3196349],
                            [119.9838998, 15.3195939],
                            [119.9838747, 15.3196428],
                            [119.9837938, 15.3196087],
                            [119.9837241, 15.3197584]
                        ]]
                    }
                },
                // 9. CTHM - Department
                {
                    type: 'Feature',
                    properties: { name: 'CTHM Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9841451, 15.3197379],
                            [119.9842144, 15.3198282],
                            [119.9845569, 15.3195988],
                            [119.9844808, 15.3195057],
                            [119.9841451, 15.3197379]
                        ]]
                    }
                },
                // 10. CABA - Department
                {
                    type: 'Feature',
                    properties: { name: 'CABA Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9844892, 15.3194934],
                            [119.9845702, 15.3195907],
                            [119.9849591, 15.3192958],
                            [119.9848935, 15.3192058],
                            [119.9844892, 15.3194934]
                        ]]
                    }
                },
                // 11. ANNEX - Department
                {
                    type: 'Feature',
                    properties: { name: 'Annex Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9846286, 15.3192387],
                            [119.984731,  15.3191697],
                            [119.984483,  15.318828],
                            [119.984386,  15.3188934],
                            [119.9846286, 15.3192387]
                        ]]
                    }
                },
                // 12. REGISTRAR - Administration
                {
                    type: 'Feature',
                    properties: { name: 'Registrar', height: 4, color: '#2c5aa0' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9843734, 15.3188732],
                            [119.9844627, 15.3188041],
                            [119.984362,  15.3186586],
                            [119.9842698, 15.3187311],
                            [119.9843734, 15.3188732]
                        ]]
                    }
                },
                // 13. SBEB - Department
                {
                    type: 'Feature',
                    properties: { name: 'SBEB Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9845511, 15.3186093],
                            [119.9844749, 15.3186669],
                            [119.984538,  15.3187487],
                            [119.9845585, 15.3187311],
                            [119.984615,  15.3187993],
                            [119.9849226, 15.3185705],
                            [119.9848788, 15.318514],
                            [119.9849027, 15.3184929],
                            [119.9848327, 15.3184029],
                            [119.9847524, 15.3184594],
                            [119.9848065, 15.3185286],
                            [119.9846092, 15.3186783],
                            [119.9845511, 15.3186093]
                        ]]
                    }
                },
                // 14. E-LIBRARY - Facilities
                {
                    type: 'Feature',
                    properties: { name: 'E-Library', height: 4, color: '#fbbc04' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9849617, 15.3186195],
                            [119.9849155, 15.3186546],
                            [119.9849284, 15.3186695],
                            [119.9848433, 15.3187337],
                            [119.9848778, 15.3187754],
                            [119.9848661, 15.3187839],
                            [119.9848593, 15.3188095],
                            [119.9848649, 15.3188399],
                            [119.9848772, 15.3188607],
                            [119.9849241, 15.3189148],
                            [119.9849494, 15.3188952],
                            [119.9849996, 15.3189585],
                            [119.9849638, 15.3189871],
                            [119.9849977, 15.3190293],
                            [119.9851334, 15.3189246],
                            [119.9850785, 15.3188568],
                            [119.9851291, 15.3188169],
                            [119.9849617, 15.3186195]
                        ]]
                    }
                },
                // 15. CTE - Department
                {
                    type: 'Feature',
                    properties: { name: 'CTE Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9850608, 15.3185194],
                            [119.9851558, 15.3184452],
                            [119.9849012, 15.3181254],
                            [119.9848005, 15.3181978],
                            [119.9850608, 15.3185194]
                        ]]
                    }
                },
                // ── BATCH 2 (features 16-30) ──
                // 16. CAS - Department
                {
                    type: 'Feature',
                    properties: { name: 'CAS Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9844281, 15.3183799],
                            [119.9846969, 15.3181921],
                            [119.9846399, 15.3181197],
                            [119.984372,  15.3183066],
                            [119.9844281, 15.3183799]
                        ]]
                    }
                },
                // 17. CLINIC - Facilities
                {
                    type: 'Feature',
                    properties: { name: 'Clinic', height: 4, color: '#fbbc04' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.984052,  15.3185425],
                            [119.9841356, 15.3186497],
                            [119.984318,  15.3185196],
                            [119.9842306, 15.3184142],
                            [119.984052,  15.3185425]
                        ]]
                    }
                },
                // 18. ADMIN BUILDING - Administration
                {
                    type: 'Feature',
                    properties: { name: 'Admin Building', height: 4, color: '#2c5aa0' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9833425, 15.318384],
                            [119.9834657, 15.3185341],
                            [119.9837505, 15.3183221],
                            [119.9836265, 15.318172],
                            [119.9833425, 15.318384]
                        ]]
                    }
                },
                // 19. AUTO - Department
                {
                    type: 'Feature',
                    properties: { name: 'AUTO Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9838964, 15.3183341],
                            [119.984307,  15.3182722],
                            [119.9842873, 15.3181575],
                            [119.9838767, 15.3182243],
                            [119.9838964, 15.3183341]
                        ]]
                    }
                },
                // 20. FSMT - Department
                {
                    type: 'Feature',
                    properties: { name: 'FSMT Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9837658, 15.3181474],
                            [119.9841661, 15.318088],
                            [119.9841456, 15.3179576],
                            [119.983741,  15.3180195],
                            [119.9837658, 15.3181474]
                        ]]
                    }
                },
                // 21. MECH - Department
                {
                    type: 'Feature',
                    properties: { name: 'MECH Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9835995, 15.3179622],
                            [119.9840152, 15.3179127],
                            [119.9839929, 15.3177576],
                            [119.9835832, 15.3178063],
                            [119.9835995, 15.3179622]
                        ]]
                    }
                },
                // 22. CIT - Department
                {
                    type: 'Feature',
                    properties: { name: 'CIT Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9834395, 15.3177494],
                            [119.9838527, 15.3176958],
                            [119.9838321, 15.3175497],
                            [119.9834199, 15.3176083],
                            [119.9834395, 15.3177494]
                        ]]
                    }
                },
                // 23. NEW BLDG - Department
                {
                    type: 'Feature',
                    properties: { name: 'New Building', height: 4, color: '#34a853', underConstruction: true },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.983282,  15.3175577],
                            [119.9836986, 15.3174967],
                            [119.9836781, 15.3173696],
                            [119.9832632, 15.3174274],
                            [119.983282,  15.3175577]
                        ]]
                    }
                },
                // 24. CIVIL - Department
                {
                    type: 'Feature',
                    properties: { name: 'Civil Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9831469, 15.3173636],
                            [119.9835275, 15.317319],
                            [119.9835096, 15.3171862],
                            [119.9831315, 15.3172308],
                            [119.9831469, 15.3173636]
                        ]]
                    }
                },
                // 25. CCIT - Department
                {
                    type: 'Feature',
                    properties: { name: 'CCIT Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9830175, 15.3170271],
                            [119.9831167, 15.3171319],
                            [119.9833237, 15.3169463],
                            [119.983227,  15.3168456],
                            [119.9830175, 15.3170271]
                        ]]
                    }
                },
                // 26. DORMITORY - Facilities
                {
                    type: 'Feature',
                    properties: { name: 'Dormitory', height: 4, color: '#fbbc04' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9838232, 15.3172916],
                            [119.9839546, 15.3171741],
                            [119.9835187, 15.3167413],
                            [119.983394,  15.3168567],
                            [119.9838232, 15.3172916]
                        ]]
                    }
                },
                // 27. EXIT - Landmark
                {
                    type: 'Feature',
                    properties: { name: 'Exit', height: 4, color: '#9c27b0' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9833586, 15.3166766],
                            [119.9834332, 15.3166047],
                            [119.9833458, 15.3165228],
                            [119.9832725, 15.3165923],
                            [119.9833586, 15.3166766]
                        ]]
                    }
                },
                // 28. NSLB - Department
                {
                    type: 'Feature',
                    properties: { name: 'NSLB Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9827756, 15.3169233],
                            [119.9828277, 15.3169735],
                            [119.982907,  15.3168981],
                            [119.9828548, 15.3168519],
                            [119.9827756, 15.3169233]
                        ]]
                    }
                },
                // 29. CON - Department
                {
                    type: 'Feature',
                    properties: { name: 'CON Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9827791, 15.3169652],
                            [119.9828604, 15.3170456],
                            [119.9825369, 15.3173321],
                            [119.9825785, 15.3173773],
                            [119.9825045, 15.3174427],
                            [119.9824754, 15.3174075],
                            [119.9822252, 15.3176304],
                            [119.9821356, 15.3175399],
                            [119.9827791, 15.3169652]
                        ]]
                    }
                },
                // 30. COE - Department
                {
                    type: 'Feature',
                    properties: { name: 'COE Department', height: 4, color: '#34a853' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9819021, 15.3177692],
                            [119.9819792, 15.3178382],
                            [119.9820091, 15.3178101],
                            [119.9820877, 15.3177752],
                            [119.9821061, 15.3177596],
                            [119.9821146, 15.317741],
                            [119.9821454, 15.3176749],
                            [119.982157,  15.3176645],
                            [119.982197,  15.3176548],
                            [119.9822166, 15.3176389],
                            [119.9821329, 15.3175535],
                            [119.9819021, 15.3177692]
                        ]]
                    }
                },
                // 31. ENTRANCE - Landmark
                {
                    type: 'Feature',
                    properties: { name: 'Entrance', height: 4, color: '#9c27b0' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9848411, 15.3199384],
                            [119.9849758, 15.3198547],
                            [119.9849126, 15.3197372],
                            [119.9847825, 15.3198152],
                            [119.9848411, 15.3199384]
                        ]]
                    }
                },
                // ── UNNAMED / OUTDATED BUILDINGS ──
                {
                    type: 'Feature',
                    properties: { name: 'Building', height: 4, color: '#d9d0c9' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9821517, 15.3190143],
                            [119.9824517, 15.3189752],
                            [119.9824265, 15.3188532],
                            [119.9821346, 15.3188908],
                            [119.9821517, 15.3190143]
                        ]]
                    }
                },
                {
                    type: 'Feature',
                    properties: { name: 'Building', height: 4, color: '#d9d0c9' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9833317, 15.3188403],
                            [119.9834568, 15.3187535],
                            [119.983391,  15.3186612],
                            [119.9832637, 15.3187485],
                            [119.9833317, 15.3188403]
                        ]]
                    }
                },
                {
                    type: 'Feature',
                    properties: { name: 'Building', height: 4, color: '#d9d0c9' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9835056, 15.3188472],
                            [119.9835521, 15.3189086],
                            [119.9836025, 15.3188702],
                            [119.9835588, 15.3188124],
                            [119.9835056, 15.3188472]
                        ]]
                    }
                },
                {
                    type: 'Feature',
                    properties: { name: 'Building', height: 4, color: '#d9d0c9' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9834964, 15.3193152],
                            [119.9837605, 15.3191283],
                            [119.9837016, 15.3190486],
                            [119.9834365, 15.3192337],
                            [119.9834964, 15.3193152]
                        ]]
                    }
                },
                {
                    type: 'Feature',
                    properties: { name: 'Building', height: 4, color: '#d9d0c9' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.984183,  15.3199122],
                            [119.9844176, 15.320218],
                            [119.9845184, 15.3201457],
                            [119.9842848, 15.3198389],
                            [119.984183,  15.3199122]
                        ]]
                    }
                },
                {
                    type: 'Feature',
                    properties: { name: 'Building', height: 4, color: '#d9d0c9' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9845289, 15.3201374],
                            [119.9847236, 15.3200126],
                            [119.9846476, 15.3198971],
                            [119.9844525, 15.3200266],
                            [119.9845289, 15.3201374]
                        ]]
                    }
                },
                {
                    type: 'Feature',
                    properties: { name: 'Building', height: 4, color: '#d9d0c9' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9850486, 15.3198483],
                            [119.9851635, 15.3197583],
                            [119.9851755, 15.3197312],
                            [119.985089,  15.3196193],
                            [119.9849546, 15.3197182],
                            [119.9850486, 15.3198483]
                        ]]
                    }
                },
                {
                    type: 'Feature',
                    properties: { name: 'Building', height: 4, color: '#d9d0c9' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9849754, 15.3192821],
                            [119.9850319, 15.3193519],
                            [119.9854902, 15.3190119],
                            [119.9855666, 15.3191074],
                            [119.9856498, 15.3190454],
                            [119.9852313, 15.3185213],
                            [119.9851562, 15.3185693],
                            [119.9854324, 15.3189418],
                            [119.9849754, 15.3192821]
                        ]]
                    }
                },
                {
                    type: 'Feature',
                    properties: { name: 'Building', height: 4, color: '#d9d0c9' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9845608, 15.3185279],
                            [119.9846654, 15.3184555],
                            [119.9846185, 15.3183922],
                            [119.9845112, 15.3184672],
                            [119.9845608, 15.3185279]
                        ]]
                    }
                },
                {
                    type: 'Feature',
                    properties: { name: 'Building', height: 4, color: '#d9d0c9' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9845393, 15.3179718],
                            [119.984589,  15.3180325],
                            [119.9846949, 15.3179601],
                            [119.9846466, 15.3178968],
                            [119.9845393, 15.3179718]
                        ]]
                    }
                },
                {
                    type: 'Feature',
                    properties: { name: 'Building', height: 4, color: '#d9d0c9' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9844642, 15.3179007],
                            [119.9845125, 15.3179602],
                            [119.9846182, 15.3178876],
                            [119.9845715, 15.3178243],
                            [119.9844642, 15.3179007]
                        ]]
                    }
                },
                {
                    type: 'Feature',
                    properties: { name: 'Building', height: 4, color: '#d9d0c9' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [119.9833367, 15.3167211],
                            [119.9834164, 15.3167999],
                            [119.9834716, 15.3167522],
                            [119.9833892, 15.3166693],
                            [119.9833367, 15.3167211]
                        ]]
                    }
                }
            ]
        }
    });

    // Flat fill
    ml.addLayer({
        id: 'building-footprints-fill',
        type: 'fill',
        source: 'building-footprints',
        paint: {
            'fill-color': '#aaaaaa',
            'fill-opacity': 0.3
        }
    });

    // Outline
    ml.addLayer({
        id: 'building-footprints-outline',
        type: 'line',
        source: 'building-footprints',
        paint: {
            'line-color': '#000000',
            'line-width': 1.5
        }
    });

    // 3D extrusion
    ml.addLayer({
        id: 'building-footprints-3d',
        type: 'fill-extrusion',
        source: 'building-footprints',
        paint: {
            'fill-extrusion-color': '#aaaaaa',
            'fill-extrusion-height': ['*', ['get', 'height'], 2],
            'fill-extrusion-base': 0,
            'fill-extrusion-opacity': 0.65
        }
    });
}



function add3DCampusBoundary() {
    const ml = map3dState.map;
    const campus = campusData[state.currentCampus];
    if (!campus.boundary) return;

    // Convert [lat, lng] → [lng, lat] for GeoJSON
    const coords = campus.boundary.map(p => [p[1], p[0]]);

    ml.addSource('campus-boundary', {
        type: 'geojson',
        data: {
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [coords]
            }
        }
    });

    // Red outline
    ml.addLayer({
        id: 'campus-boundary-line',
        type: 'line',
        source: 'campus-boundary',
        paint: {
            'line-color': '#ff0000',
            'line-width': 3,
            'line-opacity': 0.9
        }
    });

    // Subtle fill
    ml.addLayer({
        id: 'campus-boundary-fill',
        type: 'fill',
        source: 'campus-boundary',
        paint: {
            'fill-color': '#2c5aa0',
            'fill-opacity': 0.05
        }
    });
}

function add3DMarkers() {
    const ml = map3dState.map;
    const campus = campusData[state.currentCampus];

    // Remove old markers if re-adding
    map3dState.markers.forEach(m => m.remove());
    map3dState.markers = [];

    const typeColors = {
        administration: '#2c5aa0',
        department:     '#34a853',
        facilities:     '#fbbc04',
        office:         '#ea4335',
        landmark:       '#9c27b0'
    };

    const session = getAuthSession();
    const role = session?.role || 'VISITOR';

    campus.locations.forEach(location => {
        if (!Permissions.canAccessLocationType(role, location.type)) return;
        if (state.currentFilter !== 'all' && location.type !== state.currentFilter) return;

        const coords = normalizeCoords(location.coords);
        if (!coords) return;

        const color = typeColors[location.type] || '#757575';
        const label = location.shortName || location.name.substring(0, 5).toUpperCase();

        // Create label element (same style as Leaflet labels)
        const el = document.createElement('div');
        el.style.cssText = `
            background: ${color};
            color: white;
            padding: 4px 8px;
            border-radius: 10px;
            font-weight: 700;
            font-size: 10px;
            font-family: 'Segoe UI', Arial, sans-serif;
            border: 2px solid white;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            white-space: nowrap;
            cursor: pointer;
            pointer-events: auto;
            user-select: none;
        `;
        el.textContent = label;

        // Click → show popup
        el.addEventListener('click', () => {
            console.log('[3D marker] clicked:', location.name);
            show3DPopup(location, coords);
        });

        const marker = new maplibregl.Marker({ element: el })
            .setLngLat([coords[1], coords[0]])
            .addTo(ml);

        map3dState.markers.push(marker);
    });

    console.log(`[3D marker] created ${map3dState.markers.length} markers for campus "${state.currentCampus}"`);
    map3dState.markersAdded = true;
}

// ✅ ADD — 3D counterpart of updateUserLocationMarker(). Reuses the exact
// same element structure + CSS classes (.user-location-marker /
// .user-marker-pulse / .user-marker-dot from style.css) as the 2D marker,
// so the pulsing blue dot looks identical in both views — it's plain
// DOM/CSS, not a Leaflet-specific construct, so it works unmodified inside
// a maplibregl.Marker too. Called from updateUserLocationMarker() itself
// (single choke point — see there) and again on 3D entry/re-entry below,
// so the marker is present immediately rather than waiting for the next
// GPS reading.
function sync3DUserLocationMarker(lat, lng) {
    if (!map3dState.map) return;

    if (!map3dState.userMarker) {
        const el = document.createElement('div');
        el.className = 'user-location-marker';
        el.style.width = '30px';
        el.style.height = '30px';
        el.innerHTML = `
            <div class="user-marker-beam"></div>
            <div class="user-marker-pulse"></div>
            <div class="user-marker-dot"></div>
        `;

        map3dState.userMarker = new maplibregl.Marker({ element: el })
            .setLngLat([lng, lat])
            .addTo(map3dState.map);
    } else {
        map3dState.userMarker.setLngLat([lng, lat]);
    }

    // ✅ Newly created marker starts with whatever heading is already known
    // (e.g. switching into 3D mid-navigation), instead of waiting for the
    // next GPS fix to orient the beam.
    if (typeof state.deadReckoning?.heading === 'number') {
        applyUserMarkerHeading(state.deadReckoning.heading);
    }
}

// ✅ ADD — mirrors removeUserLocationMarker()'s 2D cleanup so a stale dot
// doesn't linger on the 3D map (e.g. after logout, or GPS being turned off)
// once the 2D one has been removed.
function remove3DUserLocationMarker() {
    if (map3dState.userMarker) {
        map3dState.userMarker.remove();
        map3dState.userMarker = null;
    }
}

function show3DPopup(location, coords) {
    // Remove existing popup
    if (map3dState.popup) {
        map3dState.popup.remove();
    }

    const roomsBtn = location.rooms && location.rooms.length > 0
        ? `<button onclick="closeProfilePanel(); showLocationDetails(${JSON.stringify(location).replace(/"/g, '&quot;')})"
            style="width:100%;padding:8px;background:#9c27b0;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px;margin-bottom:6px;">
            🚪 View ${location.rooms.length} Room(s)
            </button>`
        : '';

    // ✅ Mid-trip in 3D, this must behave exactly like the 2D location modal's
    // primary button (handlePrimaryLocationAction): queue as the next stop
    // instead of hijacking navigateToSelected(), which would silently desync
    // state.currentRoute from state.multiStop.stops/currentIndex.
    const midTrip = state.multiStop.active;
    const primaryLabel = midTrip ? '➕ Add as Next Stop' : '🧭 Navigate Here';
    const primaryAction = midTrip
        ? `state.selectedLocation = ${JSON.stringify(location).replace(/"/g, '&quot;')};
           msAddLocationAsStop(state.selectedLocation);
           if (map3dState.popup) { map3dState.popup.remove(); }`
        : `state.selectedLocation = ${JSON.stringify(location).replace(/"/g, '&quot;')};
           exit3DMap();
           setTimeout(() => navigateToSelected(), 400);`;

    const html = `
        <div style="min-width:200px; font-family:'Segoe UI',Arial,sans-serif;">
            <h4 style="margin:0 0 6px;color:#2c5aa0;font-size:14px;">${location.name}</h4>
            <p style="margin:0 0 8px;font-size:11px;color:#666;">
                ${location.type.charAt(0).toUpperCase() + location.type.slice(1)}
            </p>
            ${roomsBtn}
            <button onclick="${primaryAction}" style="width:100%;padding:8px;background:#2c5aa0;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px;">
                ${primaryLabel}
            </button>
        </div>
    `;

    // ✅ closeOnClick defaults to true, which registers a 'click' listener on
    // the MAP the instant addTo() runs. The marker's own click event is still
    // bubbling up through the DOM at that exact moment (the marker element
    // lives inside the map container), so that same click reaches the map and
    // immediately fires this popup's own close handler — closing it on the
    // same click that opened it. We manage open/close ourselves via marker
    // clicks, so this auto-close isn't needed anyway.
    map3dState.popup = new maplibregl.Popup({ offset: 10, closeOnClick: false })
        .setLngLat([coords[1], coords[0]])
        .setHTML(html)
        .addTo(map3dState.map);
}

// Bounded, GPU-safe dash flow — uses a small FIXED set of dasharray patterns
// (this matches MapLibre/Mapbox's official "animate a line" technique).
// Using a brand-new unique dasharray on every single frame (what we had
// before) makes MapLibre's internal dash atlas grow without limit — after a
// few seconds it overflows and the renderer falls back to a solid line,
// which is exactly the bug you saw.
const ROUTE_3D_DASH_LEN = 2;   // matches the original [2, 3] dash length
const ROUTE_3D_GAP_LEN  = 3;   // matches the original [2, 3] gap length
const ROUTE_3D_DASH_CYCLE = ROUTE_3D_DASH_LEN + ROUTE_3D_GAP_LEN;
const ROUTE_3D_DASH_STEPS = 24; // small + fixed = atlas stays bounded forever

const route3DDashSequence = Array.from({ length: ROUTE_3D_DASH_STEPS }, (_, i) => {
    // Reversed direction: flows from the user's position toward the
    // destination (not backward toward the user).
    const phase = ROUTE_3D_DASH_CYCLE - (i / ROUTE_3D_DASH_STEPS) * ROUTE_3D_DASH_CYCLE;
    if (phase < ROUTE_3D_GAP_LEN) {
        return [0, ROUTE_3D_GAP_LEN - phase, ROUTE_3D_DASH_LEN, phase];
    }
    const dashPhase = phase - ROUTE_3D_GAP_LEN;
    return [ROUTE_3D_DASH_LEN - dashPhase, ROUTE_3D_GAP_LEN, dashPhase];
});

const ROUTE_3D_DASH_FRAME_MS = 50; // ms per step — raise this number for slower flow

function animate3DRouteDash(timestamp) {
    const ml = map3dState.map;
    if (!ml || !ml.getLayer('route-3d-dashed')) {
        map3dState.dashAnimationFrame = null;
        return;
    }

    const stepIndex = Math.floor(timestamp / ROUTE_3D_DASH_FRAME_MS) % ROUTE_3D_DASH_STEPS;
    if (stepIndex !== map3dState.dashStep) {
    ml.setPaintProperty('route-3d-dashed', 'line-dasharray', route3DDashSequence[stepIndex]);

    // ✅ Only animate the dashed overlay, NOT the solid base layer
    if (ml.getLayer('route-3d-end-dashed')) {
        ml.setPaintProperty('route-3d-end-dashed', 'line-dasharray', route3DDashSequence[stepIndex]);
    }
    map3dState.dashStep = stepIndex;
}

    map3dState.dashAnimationFrame = requestAnimationFrame(animate3DRouteDash);
}

function sync3DRoute(options = {}) {
    const ml = map3dState.map;
    if (!ml || !state.currentRoute) return;
    const shouldFitBounds = options.fitBounds !== false;

    // Remove old route layers if exists
    if (ml.getSource('route-3d')) {
        ml.removeLayer('route-3d-line');
        ml.removeLayer('route-3d-dashed');
        ml.removeSource('route-3d');
    }
    // ✅ Also clean up end layers on re-sync
    if (ml.getSource('route-3d-end')) {
        ml.removeLayer('route-3d-end-line');
        ml.removeLayer('route-3d-end-dashed');
        ml.removeSource('route-3d-end');
    }

    const coords = state.currentRoute.coordinates.map(c => [c.lng, c.lat]);
    // ✅ Read the destination/type OFF THE ROUTE ITSELF, not from
    // state.selectedLocation / state.isRoomNavigation. Those two globals get
    // reassigned by ANY location the user taps afterward (e.g. opening
    // another building's modal to "Add as Next Stop"), even though the
    // active route hasn't changed. Falling back to state.currentRoute.destination
    // keeps this in sync with whatever route is actually drawn.
    const activeDestination = state.currentRoute.destination || state.selectedLocation;
    const isRoom = activeDestination
        ? (activeDestination.matchType === 'room' || !!activeDestination.buildingName)
        : state.isRoomNavigation;
    const routeColor = isRoom ? '#9c27b0' : '#2c5aa0';

    ml.addSource('route-3d', {
        type: 'geojson',
        data: {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords }
        }
    });

    ml.addLayer({
        id: 'route-3d-line',
        type: 'line',
        source: 'route-3d',
        paint: {
            'line-color': routeColor,
            'line-width': 6,
            'line-opacity': 0.85
        }
    });

    ml.addLayer({
        id: 'route-3d-dashed',
        type: 'line',
        source: 'route-3d',
        paint: {
            'line-color': '#ffffff',
            'line-width': 6,
            'line-opacity': 0.6,
            'line-dasharray': [2, 3]
        }
    });

    // ✅ End dotted line — add source FIRST, then both layers
    if (activeDestination?.coords) {
        const lastCoord = coords[coords.length - 1];
        const destCoord = [activeDestination.coords[1], activeDestination.coords[0]];

        ml.addSource('route-3d-end', {
            type: 'geojson',
            data: {
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: [lastCoord, destCoord]
                }
            }
        });

        // Colored base layer
        ml.addLayer({
            id: 'route-3d-end-line',
            type: 'line',
            source: 'route-3d-end',
            paint: {
                'line-color': routeColor,
                'line-width': 6,
                'line-opacity': 1.0  // ✅ full opacity so blue is clearly visible
            }
        });

        // White overlay on top
        ml.addLayer({
            id: 'route-3d-end-dashed',
            type: 'line',
            source: 'route-3d-end',
            paint: {
                'line-color': '#ffffff',
                'line-width': 6,
                'line-opacity': 0.5,  // ✅ reduced so blue base shows through
                'line-dasharray': [2, 3]
            }
        });
    }

    // Restart the flowing dash animation
    if (map3dState.dashAnimationFrame) {
        cancelAnimationFrame(map3dState.dashAnimationFrame);
    }
    map3dState.dashStep = -1;
    map3dState.dashAnimationFrame = requestAnimationFrame(animate3DRouteDash);

    // Fly to route bounds — only on a genuinely new/changed route. Skipped
    // for background resyncs (15s DB poll, SSE mapDataChanged, tab refocus)
    // so the camera doesn't keep snapping out while you're actively
    // navigating in 3D — see resyncMapWithDatabase()'s call below.
    if (shouldFitBounds && coords.length > 1) {
        const lngs = coords.map(c => c[0]);
        const lats = coords.map(c => c[1]);
        ml.fitBounds(
            [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
            { padding: 80, maxZoom: 18, duration: 800 }
        );
    }

    // Mirror the 2D start dotted line too — otherwise the 3D route always
    // looks like it begins exactly on the path, even when there's a real
    // gap between the path and your actual GPS position.
    if (state.userLocation) {
        addStartDottedLine3D([state.userLocation.lat, state.userLocation.lng], state.currentRoute.coordinates);
    }

    // Mirror the 2D pale "other stops" preview lines onto the 3D map —
    // sync3DRoute() previously only ever drew the single active route.
    sync3DPaleRoutes();
}

// 3D equivalent of msRenderPaleRoutes(): draws every non-active multi-stop
// leg as a faded line on the 3D map so CCIT → COE style trips show both
// lanes here too, not just in 2D.
function sync3DPaleRoutes() {
    clear3DPaleRoutes();
    const ml = map3dState.map;
    const ms = state.multiStop;
    if (!ml || !ms.active) return;

    ms.stops.forEach((stop, i) => {
        if (i === ms.currentIndex) return; // active leg — already drawn as route-3d
        if (!stop.cachedRoute || !stop.cachedRoute.coordinates.length) return;

        const coords = stop.cachedRoute.coordinates.map(c => [c[1], c[0]]); // [lat,lng] -> [lng,lat]
        const sourceId = `route-3d-pale-${i}`;
        const layerId = `${sourceId}-layer`;
        const isDone = stop.status === 'done';

        ml.addSource(sourceId, {
            type: 'geojson',
            data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } }
        });
        ml.addLayer({
            id: layerId,
            type: 'line',
            source: sourceId,
            paint: {
                'line-color': isDone ? '#9aa0a6' : '#8ab4f8',
                'line-width': 4,
                'line-opacity': isDone ? 0.35 : 0.5,
                'line-dasharray': [1.5, 1.2]
            }
        });

        map3dState.paleLayerIds.push({ sourceId, layerId });
    });
}

function clear3DPaleRoutes() {
    const ml = map3dState.map;
    if (!ml) return;
    (map3dState.paleLayerIds || []).forEach(({ sourceId, layerId }) => {
        if (ml.getLayer(layerId)) ml.removeLayer(layerId);
        if (ml.getSource(sourceId)) ml.removeSource(sourceId);
    });
    map3dState.paleLayerIds = [];
}

const OFF_ROAD_LINK_THRESHOLD_METERS_3D = 12;

// 3D equivalent of addStartDottedLine(): connects your live GPS position to
// the route's first point, same gap-threshold logic as the 2D version, so
// the 3D route doesn't misleadingly look like it starts exactly on the path.
function addStartDottedLine3D(userCoords, routeCoordinates) {
    const ml = map3dState.map;
    if (!ml) return;

    if (!userCoords || !routeCoordinates || routeCoordinates.length < 1) {
        removeStartDottedLine3D();
        return;
    }

    // ✅ Same fix as the 2D map: measure against the closest point on the
    // whole route, not just its first coordinate, so this line can't grow
    // into a stretching tail as you walk further along the path.
    const nearestOnRoute = nearestPointOnPolyline(userCoords[0], userCoords[1], routeCoordinates);
    if (!nearestOnRoute) {
        removeStartDottedLine3D();
        return;
    }
    const gapMeters = nearestOnRoute.distanceMeters;

    if (gapMeters < OFF_ROAD_LINK_THRESHOLD_METERS_3D) {
        removeStartDottedLine3D();
        return;
    }

    const isRoom = state.isRoomNavigation;
    const dottedColor = isRoom ? '#9c27b0' : '#2c5aa0';

    const geojson = {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [
                [userCoords[1], userCoords[0]],
                [nearestOnRoute.lng, nearestOnRoute.lat]
            ]
        }
    };

    if (!ml.getSource('route-3d-start')) {
        ml.addSource('route-3d-start', { type: 'geojson', data: geojson });
        ml.addLayer({
            id: 'route-3d-start-line',
            type: 'line',
            source: 'route-3d-start',
            paint: {
                'line-color': dottedColor,
                'line-width': 5,
                'line-opacity': 0.85,
                'line-dasharray': [1, 1.6]
            }
        });
    } else {
        ml.getSource('route-3d-start').setData(geojson);
        ml.setPaintProperty('route-3d-start-line', 'line-color', dottedColor);
    }
}

function removeStartDottedLine3D() {
    const ml = map3dState.map;
    if (!ml) return;
    if (ml.getLayer('route-3d-start-line')) ml.removeLayer('route-3d-start-line');
    if (ml.getSource('route-3d-start')) ml.removeSource('route-3d-start');
}

function clear3DRoute() {
    const ml = map3dState.map;

    if (map3dState.dashAnimationFrame) {
        cancelAnimationFrame(map3dState.dashAnimationFrame);
        map3dState.dashAnimationFrame = null;
    }

    clear3DPaleRoutes();
    removeStartDottedLine3D();

    if (!ml) return;
    if (ml.getSource('route-3d')) {
        ml.removeLayer('route-3d-line');
        ml.removeLayer('route-3d-dashed');
        ml.removeSource('route-3d');
    }
    // ✅ ADD: clean up end dotted layer too
    if (ml.getSource('route-3d-end')) {
        ml.removeLayer('route-3d-end-line');
        ml.removeLayer('route-3d-end-dashed'); // ✅ ADD
        ml.removeSource('route-3d-end');
    }
}

// ✅ Prevent accidental pinch/double-tap zoom on the header, specifically for
// installed PWA use on mobile. CSS touch-action: pan-x pan-y (see .main-header
// in style.css) covers most browsers, but Safari/iOS — the most common case
// for an installed PWA — also fires its own non-standard 'gesturestart' /
// 'gesturechange' event for pinch gestures that isn't reliably suppressed by
// touch-action alone in every WebView context. This adds a belt-and-suspenders
// JS layer for that, plus a narrow double-tap-zoom guard.
//
// Both listeners explicitly bail out early if the touch/gesture target is (or
// is inside) an interactive element — buttons, links, or anything with an
// onclick — so profile chip taps, menu buttons, etc. are never intercepted.
// Only zoom gestures starting on the header's plain background/text are
// blocked.
document.addEventListener('DOMContentLoaded', () => {
    const header = document.querySelector('.main-header');
    if (!header) return;

    function isInteractiveTarget(target) {
        return !!(target && target.closest && target.closest(
            'button, a, input, select, textarea, [role="button"], [onclick], .header-user-chip'
        ));
    }

    // Safari/iOS-only non-standard pinch gesture events.
    header.addEventListener('gesturestart', (e) => {
        if (!isInteractiveTarget(e.target)) e.preventDefault();
    }, { passive: false });
    header.addEventListener('gesturechange', (e) => {
        if (!isInteractiveTarget(e.target)) e.preventDefault();
    }, { passive: false });

    // Fallback double-tap-zoom guard (covers browsers where excluding
    // pinch-zoom from touch-action doesn't also suppress double-tap-zoom).
    let lastHeaderTouchEnd = 0;
    header.addEventListener('touchend', (e) => {
        if (isInteractiveTarget(e.target)) return; // never block button taps
        const now = Date.now();
        if (now - lastHeaderTouchEnd <= 300) {
            e.preventDefault();
        }
        lastHeaderTouchEnd = now;
    }, { passive: false });
});

// Auto-start the app
document.addEventListener('DOMContentLoaded', () => {
    const session = getAuthSession();

    // ✅ Session restoration must respect role too, not just fresh logins.
    // Without this, an Admin whose session survives a server restart (or who
    // simply lands back on index.html directly) gets dropped into the Main
    // App instead of being sent to admin.html.
    //
    // Skip the redirect when embedded in admin.html's own "Navigate Map"
    // iframe — that's an intentional same-origin embed of index.html, not a
    // stray top-level visit, and redirecting there would just loop.
    const inIframe = window.self !== window.top;

    // Old no-account guest sessions are no longer valid — force a real login.
    if (session && (session.isGuest || !session.userId)) {
        localStorage.removeItem(AUTH_SESSION_KEY);
        init();
        return;
    }

    if (session) {
        if ((session.role || '').toUpperCase() === 'ADMIN' && !inIframe) {
            window.location.href = '/admin.html';
            return;
        }
        setupAuthHandlers();
        startAppAfterAuth();
    } else {
        init();
    }
});