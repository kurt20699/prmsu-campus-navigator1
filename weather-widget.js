/* ============================================================
   weather-widget.js
   Self-contained "🌤️ Campus Weather" card for PRMSU Iba Campus.

   Renders into the #campusWeatherCard markup already in index.html
   (top of the sidebar, above the Campus Alerts / Campus Tips tabs).
   Fetches from GET /api/weather — server.js proxies Open-Meteo (a
   free, no-API-key weather provider) for the Iba Campus coordinates
   and returns { ok, temperatureC, condition, icon, updatedAt }.

   Does not touch the map, navigation, AI Chat, Campus Alerts, or
   Campus Tips in any way — own markup, own fetch, own refresh loop,
   no shared state with any other file.
   ============================================================ */
(function () {
    'use strict';

    const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 min — weather doesn't change fast enough to justify more
    const FETCH_TIMEOUT_MS = 8000;              // don't let a slow connection hang the card indefinitely

    const els = {};
    let hasLoadedOnce = false;
    let refreshTimer = null;

    function cacheEls() {
        els.card = document.getElementById('campusWeatherCard');
        els.icon = document.getElementById('weatherIcon');
        els.temp = document.getElementById('weatherTemp');
        els.condition = document.getElementById('weatherCondition');
    }

    function setLoadingState() {
        if (!els.card) return;
        els.card.classList.remove('weather-error');
        if (els.icon) els.icon.textContent = '⏳';
        if (els.temp) els.temp.textContent = '--°C';
        if (els.condition) els.condition.textContent = 'Loading weather…';
    }

    function setErrorState() {
        if (!els.card) return;
        els.card.classList.add('weather-error');
        if (els.icon) els.icon.textContent = '⚠️';
        if (els.temp) els.temp.textContent = '--°C';
        if (els.condition) els.condition.textContent = 'Weather unavailable right now';
    }

    function renderWeather(data) {
        if (!els.card) return;
        els.card.classList.remove('weather-error');
        if (els.icon) els.icon.textContent = data.icon || '⛅';
        if (els.temp) els.temp.textContent = `${Math.round(data.temperatureC)}°C`;
        if (els.condition) els.condition.textContent = data.condition || 'Weather';
    }

    async function loadWeather() {
        if (!els.card) return;
        // Only flash "Loading…" on the very first load — auto-refreshes
        // update quietly in place so the card doesn't flicker every 10 min.
        if (!hasLoadedOnce) setLoadingState();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
            const res = await fetch('/api/weather', { signal: controller.signal });
            const data = await res.json();
            clearTimeout(timeoutId);

            if (!data.ok || typeof data.temperatureC !== 'number') {
                throw new Error(data.error || 'Weather data unavailable');
            }

            renderWeather(data);
            hasLoadedOnce = true;
        } catch (e) {
            clearTimeout(timeoutId);
            console.warn('Could not load campus weather:', e.message);
            // ✅ Graceful degradation — if real data is already on screen,
            // leave it there; a failed/slow refresh shouldn't blank out a
            // perfectly good previous reading. Only show the explicit error
            // state if nothing has ever loaded successfully yet.
            if (!hasLoadedOnce) setErrorState();
        }
    }

    function startAutoRefresh() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(loadWeather, REFRESH_INTERVAL_MS);
    }

    function init() {
        cacheEls();
        if (!els.card) return; // markup not present — nothing to wire up
        loadWeather();
        startAutoRefresh();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();