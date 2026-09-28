/* ============================================================
   voice-navigation.js
   Self-contained Voice (Text-to-Speech) turn-by-turn navigation.

   Owns EVERYTHING voice-related: the on-screen toggle button, the
   "Voice guidance active" status pill, speechSynthesis calls, mute
   state, and deciding when an instruction should be spoken.

   Talks to the existing navigation system (script.js) through THREE
   events only — it never reads state.userLocation, state.currentRoute,
   or any GPS/Kalman-filter internals directly, and script.js never
   imports or calls into this file:

     document.addEventListener('navRouteStarted', e => ...)   // e.detail.route = { coordinates, instructions, destination, profile }
     document.addEventListener('navRouteCleared', () => ...)
     document.addEventListener('navLocationUpdate', e => ...) // e.detail = { lat, lng, accuracy }

   Each route.instructions[i] is expected to look like:
     { type: 'turn-left' | 'turn-right' | 'turn-sharp-left' | 'turn-sharp-right'
            | 'turn-slight-left' | 'turn-slight-right' | 'straight' | 'roundabout'
            | 'uturn' | 'arrive' | 'depart' | 'continue',
       road: string,
       distance: number,          // meters, length of this step
       location: {lat,lng} | null // where the maneuver happens
     }

   Usage: just include this one file, anywhere after script.js:
     <script src="voice-navigation.js" defer></script>
   No other markup or CSS needed in index.html — this injects its own,
   same pattern as ai-chat-widget.js.
   ============================================================ */
(function () {
    'use strict';

    const STORAGE_KEY = 'campusNavigatorVoiceNavEnabled';
    const ANNOUNCE_DISTANCE_METERS = 40;   // start speaking a turn once this close to it
    const ARRIVAL_DISTANCE_METERS = 15;    // "you have arrived" threshold
    const PASS_THRESHOLD_METERS = 8;       // close enough to a turn to consider it "done", move to the next
    const DEVIATION_METERS = 150;          // far enough off-target to re-pick the nearest upcoming turn instead
    const REPEAT_COOLDOWN_MS = 8000;       // never re-speak the exact same sentence within this window

    const supportsTTS = typeof window !== 'undefined' && 'speechSynthesis' in window;

    // ── Persisted mute/enable preference ───────────────────────
    let enabled = true;
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved !== null) enabled = saved === 'true';
    } catch { /* localStorage unavailable — default to enabled */ }

    // ── Live guidance state (reset on every navRouteStarted) ───
    let route = null;            // the { coordinates, instructions, destination, profile } handed to us
    let targetIndex = -1;        // index into route.instructions we're currently approaching
    let targetAnnounced = false; // has the CURRENT target already been spoken?
    let arrivedAnnounced = false;
    let lastSpokenText = null;
    let lastSpokenAt = 0;
    let active = false;          // true while a route with real turn-by-turn instructions is loaded

    // ── 1. Inject styles ────────────────────────────────────────
    const style = document.createElement('style');
    style.id = 'voice-nav-styles';
    style.textContent = `
        #voiceNavToggle {
            position: fixed;
            left: 16px;
            bottom: 24px;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background: #1e5b7a;
            color: #fff;
            border: none;
            font-size: 20px;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0,0,0,0.25);
            z-index: 2000;
            display: none;
            align-items: center;
            justify-content: center;
            transition: background 0.2s;
        }
        #voiceNavToggle.visible { display: flex; }
        #voiceNavToggle.muted {
            background: #6b7280;
        }
        #voiceNavStatus {
            position: fixed;
            left: 16px;
            bottom: 78px;
            max-width: min(280px, calc(100vw - 88px));
            background: rgba(15, 58, 82, 0.92);
            color: #fff;
            font-family: system-ui, sans-serif;
            font-size: 12.5px;
            line-height: 1.4;
            padding: 8px 12px;
            border-radius: 10px;
            box-shadow: 0 4px 14px rgba(0,0,0,0.25);
            z-index: 1999;
            display: none;
            align-items: center;
            gap: 6px;
        }
        #voiceNavStatus.visible { display: flex; }
        #voiceNavStatus .voice-nav-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: #4ade80;
            flex-shrink: 0;
            animation: voiceNavPulse 1.4s ease-in-out infinite;
        }
        #voiceNavStatus.muted .voice-nav-dot {
            background: #9ca3af;
            animation: none;
        }
        @keyframes voiceNavPulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.35; }
        }

        /* ── Mobile — keep clear of the toggle/status stack and other
           floating controls (ai-chat-toggle sits bottom-right) ── */
        @media (max-width: 768px) {
            #voiceNavToggle {
                left: 12px;
                bottom: calc(88px + 52px + 12px + env(safe-area-inset-bottom));
                width: 46px;
                height: 46px;
                font-size: 19px;
            }
            #voiceNavStatus {
                left: 12px;
                bottom: calc(88px + 52px + 12px + 58px + env(safe-area-inset-bottom));
                max-width: calc(100vw - 24px);
            }
        }
    `;
    document.head.appendChild(style);

    // ── 2. Inject markup ────────────────────────────────────────
    const wrapper = document.createElement('div');
    wrapper.id = 'voice-nav-widget-root';
    wrapper.innerHTML = `
        <div id="voiceNavStatus" role="status" aria-live="polite">
            <span class="voice-nav-dot" aria-hidden="true"></span>
            <span id="voiceNavStatusText">Voice guidance active</span>
        </div>
        <button id="voiceNavToggle" type="button" aria-pressed="true" aria-label="Mute voice navigation">
            <span id="voiceNavIcon">🔊</span>
        </button>
    `;
    document.body.appendChild(wrapper);

    const toggleBtn = document.getElementById('voiceNavToggle');
    const iconEl = document.getElementById('voiceNavIcon');
    const statusEl = document.getElementById('voiceNavStatus');
    const statusTextEl = document.getElementById('voiceNavStatusText');

    // ✅ Public API — lets other code (or the user, via devtools) query or
    // change voice nav state without reaching into this file's internals.
    window.VoiceNavigation = {
        isSupported: () => supportsTTS,
        isEnabled: () => enabled,
        setEnabled: (value) => setEnabled(!!value)
    };

    function updateToggleUI() {
        toggleBtn.setAttribute('aria-pressed', String(enabled));
        toggleBtn.title = enabled ? 'Mute voice navigation' : 'Unmute voice navigation';
        toggleBtn.setAttribute('aria-label', toggleBtn.title);
        iconEl.textContent = enabled ? '🔊' : '🔇';
        toggleBtn.classList.toggle('muted', !enabled);
        statusEl.classList.toggle('muted', !enabled);
    }

    function setEnabled(value) {
        enabled = value;
        try { localStorage.setItem(STORAGE_KEY, String(enabled)); } catch { /* ignore */ }
        updateToggleUI();
        if (!enabled) {
            supportsTTS && window.speechSynthesis.cancel();
            setStatusText('Voice guidance muted');
        } else if (active) {
            setStatusText('Voice guidance active');
            speak('Voice guidance resumed.');
        }
    }

    // Unlocks speechSynthesis on iOS/Android, which otherwise silently
    // refuses to speak anything that wasn't triggered by a real tap.
    function primeSpeechSynthesis() {
        if (!supportsTTS) return;
        try {
            const primer = new SpeechSynthesisUtterance('');
            primer.volume = 0;
            window.speechSynthesis.speak(primer);
        } catch { /* ignore */ }
    }
    document.addEventListener('pointerdown', primeSpeechSynthesis, { once: true, passive: true });

    toggleBtn.addEventListener('click', () => {
        primeSpeechSynthesis();
        setEnabled(!enabled);
    });

    updateToggleUI();
    if (!supportsTTS) {
        toggleBtn.disabled = true;
        toggleBtn.title = 'Voice navigation is not supported on this device/browser';
    }

    function showWidget() {
        toggleBtn.classList.add('visible');
        statusEl.classList.add('visible');
    }
    function hideWidget() {
        toggleBtn.classList.remove('visible');
        statusEl.classList.remove('visible');
    }
    function setStatusText(text) {
        statusTextEl.textContent = text;
    }

    // ── Speech ──────────────────────────────────────────────────
    function speak(text) {
        if (!supportsTTS || !enabled) return;
        try {
            // Always speak the freshest instruction — never queue behind a
            // stale one the user has already walked past.
            window.speechSynthesis.cancel();
            const utter = new SpeechSynthesisUtterance(text);
            utter.rate = 1;
            utter.pitch = 1;
            utter.volume = 1;
            window.speechSynthesis.speak(utter);
        } catch (e) {
            console.warn('Voice navigation TTS failed:', e);
        }
    }

    // Avoids repeating the identical sentence back-to-back within the
    // cooldown window (e.g. two GPS fixes landing in the same announce
    // radius a second apart).
    function speakOnce(text) {
        const now = Date.now();
        if (text === lastSpokenText && (now - lastSpokenAt) < REPEAT_COOLDOWN_MS) return;
        lastSpokenText = text;
        lastSpokenAt = now;
        speak(text);
        setStatusText(text);
    }

    // ── Phrasing ────────────────────────────────────────────────
    // ✅ Deliberately NOT reimplemented here. The spoken text must be the
    // exact same wording as the Turn-by-turn Directions panel, so it comes
    // from script.js's buildInstructionText() — the ONE function that
    // knows how to turn an instruction into words (see script.js,
    // INSTRUCTION_LABELS / buildInstructionText, right next to
    // getDirectionIcon() which the panel itself calls). This file only
    // decides WHEN to speak and WHICH distance number to pass in; script.js
    // decides WHAT WORDS to use. If that function isn't available (e.g.
    // this file loaded before script.js, or script.js is an older
    // version), this file logs a warning and stays silent rather than
    // falling back to its own guessed phrasing — a silent gap is safer
    // than the panel and the voice saying two different things.
    function textFor(instr, distanceMetersOverride) {
        if (typeof window.buildInstructionText !== 'function') {
            if (!textFor._warned) {
                console.warn('Voice Navigation: window.buildInstructionText is missing — update script.js. Voice guidance will stay silent.');
                textFor._warned = true;
            }
            return null;
        }
        return window.buildInstructionText(instr, distanceMetersOverride, route?.destination?.name);
    }

    // ── Local geometry helper — deliberately self-contained rather than
    // calling script.js's calculateDistance(), so this file has zero
    // dependency on the main file loading first or exposing anything.
    // A straight-line distance to each turn's point is an acceptable
    // approximation for the short, fairly direct legs between turns on a
    // single campus. ──
    function distanceMeters(lat1, lng1, lat2, lng2) {
        const R = 6371000;
        const toRad = d => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function nextIndexWithLocation(fromIdx) {
        if (!route?.instructions) return -1;
        let i = fromIdx;
        while (i < route.instructions.length && !route.instructions[i].location) i++;
        return i;
    }

    // Picks whichever remaining instruction is geographically closest to
    // the user right now — used when the user has drifted far enough from
    // the instruction we were counting down to that it no longer makes
    // sense to keep announcing it (deviated from the expected path).
    function findNearestUpcomingInstruction(lat, lng) {
        if (!route?.instructions) return null;
        let best = null;
        route.instructions.forEach((instr, i) => {
            if (!instr.location || instr.type === 'arrive') return;
            const d = distanceMeters(lat, lng, instr.location.lat, instr.location.lng);
            if (!best || d < best.distance) best = { index: i, distance: d };
        });
        return best;
    }

    // ── Core guidance loop — the only thing driven by navLocationUpdate ──
    function handleLocationUpdate(lat, lng) {
        if (!active || !route?.instructions?.length) return;

        if (targetIndex === -1) {
            targetIndex = nextIndexWithLocation(0);
            targetAnnounced = false;
        }
        if (targetIndex < 0 || targetIndex >= route.instructions.length) return;

        const instr = route.instructions[targetIndex];
        let dist = distanceMeters(lat, lng, instr.location.lat, instr.location.lng);

        // ✅ Deviation handling — if we're well outside the announce radius
        // AND a different remaining instruction is actually closer right
        // now, re-target to that one instead of blindly counting down a
        // turn the user may have skipped or walked away from.
        if (dist > DEVIATION_METERS) {
            const reselected = findNearestUpcomingInstruction(lat, lng);
            if (reselected && reselected.index !== targetIndex && reselected.distance < dist) {
                targetIndex = reselected.index;
                targetAnnounced = false;
                return; // re-evaluate fresh on the next location update
            }
        }

        const currentInstr = route.instructions[targetIndex];
        dist = distanceMeters(lat, lng, currentInstr.location.lat, currentInstr.location.lng);

        if (currentInstr.type === 'arrive') {
            if (dist <= ARRIVAL_DISTANCE_METERS && !arrivedAnnounced) {
                arrivedAnnounced = true;
                // ✅ Same "You have arrived at {destination}." text the panel
                // renders as "🎯 Arrive at {destination.name}" — sourced from
                // script.js, not hardcoded here.
                const text = textFor(currentInstr, null);
                if (text) speakOnce(text);
            }
            return;
        }

        if (!targetAnnounced && dist <= ANNOUNCE_DISTANCE_METERS) {
            targetAnnounced = true;
            const text = textFor(currentInstr, dist);
            if (text) speakOnce(text);
        } else if (!targetAnnounced) {
            // Same wording as what WILL be spoken once in range — the status
            // pill and the eventual announcement are never two different
            // sentences for the same instruction.
            const text = textFor(currentInstr, dist);
            if (text) setStatusText(text);
        }

        if (dist <= PASS_THRESHOLD_METERS) {
            targetIndex = nextIndexWithLocation(targetIndex + 1);
            targetAnnounced = false;
        }
    }

    function resetGuidanceState() {
        targetIndex = -1;
        targetAnnounced = false;
        arrivedAnnounced = false;
        lastSpokenText = null;
    }

    // ── Wire into the existing navigation system — events only ────
    document.addEventListener('navRouteStarted', (e) => {
        route = e.detail?.route || null;
        resetGuidanceState();
        active = !!(route && Array.isArray(route.instructions) && route.instructions.length);

        if (active) {
            showWidget();
            setStatusText(enabled ? 'Voice guidance active' : 'Voice guidance muted');
            if (enabled) speak('Voice guidance active.');
            // Next real location update (navLocationUpdate) will immediately
            // find and display/speak the first upcoming instruction via
            // handleLocationUpdate() — nothing further to do here.
        } else {
            hideWidget();
        }
    });

    document.addEventListener('navRouteCleared', () => {
        route = null;
        active = false;
        resetGuidanceState();
        supportsTTS && window.speechSynthesis.cancel();
        hideWidget();
    });

    document.addEventListener('navLocationUpdate', (e) => {
        const { lat, lng } = e.detail || {};
        if (typeof lat === 'number' && typeof lng === 'number') {
            handleLocationUpdate(lat, lng);
        }
    });

    // Most mobile browsers suspend speechSynthesis on backgrounding anyway;
    // explicitly cancelling avoids a stale utterance firing oddly the
    // instant the user switches back to the tab.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && supportsTTS) {
            window.speechSynthesis.cancel();
        }
    });
})();