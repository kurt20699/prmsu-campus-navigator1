    /* ============================================================
    location-filter.js
    Standalone GPS location filtering for PRMSU Smart Campus Navigator.

    Two independent pieces, combined by createLocationFilter():

    1. OutlierGuard — rejects a single wild GPS spike (common near
        buildings/trees from multipath reflection) unless the very next
        fix confirms the jump was real movement, not noise.

    2. GeoKalmanFilter — a standard 1D-per-axis Kalman filter for lat/lng.
        Replaces hand-tuned smoothing constants with a principled model:
        trust in each new fix is derived from its own reported accuracy
        and the filter's running uncertainty, so it naturally balances
        "responsive" vs "stable" instead of needing manually-picked
        smoothing factors.

    Exposed globally as window.LocationFilter. Load this file BEFORE
    script.js (e.g. <script src="location-filter.js"></script> above
    <script src="script.js"></script>) — script.js reads
    window.LocationFilter at startup and falls back to passing fixes
    straight through if this file failed to load for any reason.
    ============================================================ */
(function (root) {
    'use strict';

    // ── Shared distance helper (self-contained — no dependency on script.js) ──
    function haversineMeters(lat1, lng1, lat2, lng2) {
        const R = 6371000;
        const rLat1 = lat1 * Math.PI / 180;
        const rLat2 = lat2 * Math.PI / 180;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // ── 1. Outlier rejection ───────────────────────────────────────────
    // A single fix that jumps far from the last accepted position is held
    // as "pending" rather than applied. If the NEXT fix lands near that
    // pending point, the jump is confirmed as real movement and both are
    // accepted. If not, the pending fix is discarded as a one-off spike.
    class OutlierGuard {
        constructor({ baseThresholdMeters = 30, accuracyMultiplier = 2 } = {}) {
            this.baseThresholdMeters = baseThresholdMeters;
            this.accuracyMultiplier = accuracyMultiplier;
            this.lastAccepted = null; // { lat, lng }
            this.pending = null;      // { lat, lng, accuracy }
        }

        reset() {
            this.lastAccepted = null;
            this.pending = null;
        }

        // Returns { accept: true, lat, lng } or { accept: false } (caller
        // should skip this update entirely when accept is false).
        check(lat, lng, accuracy) {
            // First-ever fix: nothing to compare against, always accept.
            if (!this.lastAccepted) {
                this.lastAccepted = { lat, lng };
                return { accept: true, lat, lng };
            }

            const threshold = Math.max(this.baseThresholdMeters, accuracy * this.accuracyMultiplier);
            const gap = haversineMeters(this.lastAccepted.lat, this.lastAccepted.lng, lat, lng);

            if (gap <= threshold) {
                // Ordinary fix, well within plausible movement — accept directly.
                this.lastAccepted = { lat, lng };
                this.pending = null;
                return { accept: true, lat, lng };
            }

            // Big jump. Check whether it confirms a previously pending jump
            // (i.e. two consecutive fixes agree the user really moved this
            // far) — if so, trust it now.
            if (this.pending) {
                const confirmGap = haversineMeters(this.pending.lat, this.pending.lng, lat, lng);
                if (confirmGap <= threshold) {
                    this.lastAccepted = { lat, lng };
                    this.pending = null;
                    return { accept: true, lat, lng };
                }
            }

            // Unconfirmed spike — hold it as pending, tell the caller to
            // ignore this update entirely.
            this.pending = { lat, lng, accuracy };
            return { accept: false };
        }
    }

    // ── 2. Kalman filter (per-axis, lat/lng independently) ────────────
    // Standard GPS Kalman filter pattern: state = current best estimate,
    // variance = current uncertainty (in meters²). Uncertainty grows over
    // time (process noise, i.e. "the user could be moving"), and shrinks
    // whenever a new measurement arrives, weighted by that measurement's
    // own reported accuracy.
    class GeoKalmanFilter {
        constructor({ processNoise = 3 } = {}) {
            this.Q = processNoise; // meters/sec of assumed drift — how "mobile" we assume the user to be
            this.minAccuracy = 1;  // meters — floor so a suspiciously perfect accuracy can't zero out uncertainty
            this.variance = -1;    // -1 = uninitialized
            this.lat = null;
            this.lng = null;
            this.timestampMs = null;
        }

        reset() {
            this.variance = -1;
            this.lat = null;
            this.lng = null;
            this.timestampMs = null;
        }

        // accuracy in meters, timestampMs defaults to now.
        process(lat, lng, accuracy, timestampMs = Date.now()) {
            const acc = Math.max(accuracy, this.minAccuracy);

            if (this.variance < 0) {
                // First reading — initialize directly from the raw fix.
                this.timestampMs = timestampMs;
                this.lat = lat;
                this.lng = lng;
                this.variance = acc * acc;
                return { lat: this.lat, lng: this.lng, accuracy: acc };
            }

            const dtSeconds = Math.max(0, (timestampMs - this.timestampMs) / 1000);
            this.timestampMs = timestampMs;

            if (dtSeconds > 0) {
                // Uncertainty grows the longer it's been since the last fix —
                // this is what lets a stale filter "catch up" quickly to a
                // fix after a gap, instead of clinging to an old estimate.
                this.variance += dtSeconds * this.Q * this.Q;
            }

            // Kalman gain: how much to trust this new measurement vs the
            // current estimate. High when our uncertainty is high relative
            // to the fix's own accuracy; low when the estimate is already
            // confident and this fix is comparatively noisy.
            const K = this.variance / (this.variance + acc * acc);

            this.lat += K * (lat - this.lat);
            this.lng += K * (lng - this.lng);
            this.variance = (1 - K) * this.variance;

            return { lat: this.lat, lng: this.lng, accuracy: Math.sqrt(this.variance) };
        }
    }

    // ── 3. Combined pipeline ───────────────────────────────────────────
    // outlierOptions / kalmanOptions let the caller tune thresholds without
    // touching this file. `accuracyInflation` (optional, per-call) lets the
    // caller express "trust this particular fix less" (e.g. an app-specific
    // sanity check like being outside an expected boundary) by treating it
    // as if its accuracy were worse — the Kalman filter then naturally
    // weights it down, without location-filter.js needing to know anything
    // about campus boundaries or routes itself.
    function createLocationFilter({ outlierOptions, kalmanOptions } = {}) {
        const guard = new OutlierGuard(outlierOptions);
        const kalman = new GeoKalmanFilter(kalmanOptions);

        return {
            // Returns null if this fix was rejected as a likely one-off
            // spike (caller should skip the update entirely), otherwise
            // { lat, lng, accuracy } — the filtered position + the filter's
            // own current uncertainty estimate (useful for an accuracy
            // circle, independent of the raw accuracy value).
            process(lat, lng, accuracy, timestampMs = Date.now(), accuracyInflation = 1) {
                const result = guard.check(lat, lng, accuracy);
                if (!result.accept) return null;

                const effectiveAccuracy = accuracy * Math.max(1, accuracyInflation);
                return kalman.process(result.lat, result.lng, effectiveAccuracy, timestampMs);
            },
            reset() {
                guard.reset();
                kalman.reset();
            }
        };
    }

    root.LocationFilter = { OutlierGuard, GeoKalmanFilter, createLocationFilter, haversineMeters };
})(typeof window !== 'undefined' ? window : this);