/**
 * permissions.js
 * Shared role-based access control (RBAC) module for PRMSU Smart Campus Navigator.
 *
 * Works in TWO environments with the SAME rules:
 *   1. Browser  -> loaded via <script src="permissions.js"></script>, exposes window.Permissions
 *   2. Node.js  -> loaded via require('./permissions.js') in server.js
 *
 * Design: type-based access. Every building in campusData has a `type` field
 * (department | administration | facilities | office | landmark). Each role
 * is granted a whitelist of building types it may see, search, or navigate to.
 * Feature flags gate everything else (saved locations, route history, multi-stop).
 *
 * Visitors are stricter: instead of a building-type whitelist, a Visitor only
 * sees the places tied to the PURPOSE of their visit (see VISIT_PURPOSES
 * below), plus a few always-visible public places (gates, clinic, canteens).
 * server.js applies these same rules to /api/buildings, /api/rooms and the
 * AI chat, so the limit is enforced on the server, not only hidden on screen.
 *
 * Extending later: add a new ROLES entry + a new ROLE_CONFIG block. Nothing
 * else needs to change — every consumer (client filtering, server middleware)
 * reads from ROLE_CONFIG.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        // Node / CommonJS (server.js)
        module.exports = factory();
    } else {
        // Browser
        root.Permissions = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {

    const ROLES = Object.freeze({
        VISITOR: 'VISITOR',
        STUDENT: 'STUDENT',
        EMPLOYEE: 'EMPLOYEE',
        ADMIN: 'ADMIN'
    });

    // All known campusData location "type" values.
    const LOCATION_TYPES = Object.freeze([
        'department',
        'administration',
        'facilities',
        'office',
        'landmark'
    ]);

    // ── Visitor purposes → the places each purpose unlocks ──────────────
    // Each destination rule is one of:
    //   { building: 'SHORT NAME' }                      building only, no rooms
    //   { building: 'SHORT NAME', rooms: ['Room', …] }  building + only these rooms
    //   { building: 'SHORT NAME', rooms: '*' }          building + all its rooms
    //   { buildingType: 'department', roomPattern: '…' } every building of that
    //        type, but only rooms whose name matches the pattern (case-insensitive)
    // `building` is the building's Short Name as set in Admin → Buildings.
    // `places` is the plain-language summary shown to the visitor.
    const VISIT_PURPOSES = Object.freeze([
        {
            value: 'enrollment', label: 'Enrollment / Admission Inquiry',
            places: 'Registrar Building and the Cashier',
            destinations: [
                { building: 'REGISTRAR' },
                { building: 'ADMIN BLDG.', rooms: ['Cashier'] }
            ]
        },
        {
            value: 'documents', label: 'Request for Documents / Records',
            places: 'Registrar Building and the Records Management Services Office',
            destinations: [
                { building: 'REGISTRAR' },
                { building: 'ADMIN BLDG.', rooms: ['Records Management Services Office'] }
            ]
        },
        {
            value: 'payment', label: 'Payment / Cashier Transaction',
            places: 'Cashier and the Collecting and Disbursing Office',
            destinations: [
                { building: 'ADMIN BLDG.', rooms: ['Cashier', 'Collecting and Disbursing Office'] }
            ]
        },
        {
            value: 'faculty', label: 'Meeting with Faculty / Staff',
            places: "Deans' offices, faculty rooms and program chairs' offices of each college",
            destinations: [
                { buildingType: 'department', roomPattern: 'dean|faculty|chair' }
            ]
        },
        {
            value: 'official', label: 'Official Business / Government Transaction',
            places: 'Administration Building offices',
            destinations: [
                { building: 'ADMIN BLDG.', rooms: '*' }
            ]
        },
        {
            value: 'event', label: 'Attend Event / Seminar / Program',
            places: 'Gymnasium, New Gymnasium and the Gender and Development Center',
            destinations: [
                { building: 'GYMNASIUM' },
                { building: 'NEW GYMNASIUM' },
                { building: 'GAD Office' }
            ]
        },
        {
            value: 'interview', label: 'Job Application / Interview',
            places: 'Human Resources Management Office and the Interview Room',
            destinations: [
                { building: 'ADMIN BLDG.', rooms: ['Human Resources Management Office', 'Interview Room'] }
            ]
        },
        {
            value: 'guardian', label: 'Parent / Guardian Concern',
            places: "Registrar Building, Gender and Development Center, and each college's Dean's Office",
            destinations: [
                { building: 'REGISTRAR' },
                { building: 'GAD Office' },
                { buildingType: 'department', roomPattern: 'dean' }
            ]
        },
        {
            value: 'delivery', label: 'Delivery / Supplier',
            places: 'Supply Office and the Procurement Management Office',
            destinations: [
                { building: 'CLINIC' },   // "University Health Clinic / Supply Office"
                { building: 'ADMIN BLDG.', rooms: ['Procurement Management Office'] }
            ]
        },
        {
            value: 'tour', label: 'Campus Tour / Visit',
            places: 'Landmarks and public facilities (statue, library, gymnasiums, canteens)',
            destinations: [
                { building: 'STATUE' },
                { building: 'LIBRARY' },
                { building: 'GYMNASIUM' },
                { building: 'NEW GYMNASIUM' }
            ]
        },
        {
            value: 'other', label: 'Other (please specify)', requiresDetails: true,
            places: 'Administration Building (please ask at the front office)',
            destinations: [
                { building: 'ADMIN BLDG.' }
            ]
        }
    ]);

    // Visitor accounts work only between these hours (Philippine time, 24h).
    // They can be created and used from 7:00 AM, and expire at 5:00 PM.
    const VISITOR_ACCESS_HOURS = Object.freeze({ start: 7, end: 17 });

    // Exit gates (Short Names). Reaching one after the visit checks the
    // visitor out.
    const VISITOR_EXIT_GATES = Object.freeze([
        'Front Gate',
        'Rear Gate'
    ]);

    // Shown to every Visitor regardless of purpose (safety and comfort).
    const VISITOR_ALWAYS_VISIBLE = Object.freeze([
        ...VISITOR_EXIT_GATES,
        'CLINIC',
        'CAFETERIA',
        'COOP'
    ]);

    // ── Per-role configuration ──────────────────────────────────────────
    // allowedTypes: 'all' | array of LOCATION_TYPES
    // features: capability flags checked throughout the app
    const ROLE_CONFIG = {
        [ROLES.VISITOR]: {
            // Only used as a fallback. Visitors are normally limited by the
            // purpose of their visit instead (see VISIT_PURPOSES above).
            allowedTypes: ['facilities', 'office', 'landmark', 'administration'],
            features: {
                saveLocations: false,
                routeHistory: true,
                multiStop: true,
                roomInstructor: false,
                searchRooms: true,
                submitAnnouncements: false,
                campusTips: false,           // ✅ Campus Alerts/Tips hidden from Visitors
                campusAlerts: false,         // ✅ Campus Alerts/Tips hidden from Visitors
                requireVisitPurpose: true    // ✅ must state a purpose of visit
            }
        },
        [ROLES.STUDENT]: {
            allowedTypes: 'all',
            features: {
                saveLocations: true,
                routeHistory: true,
                multiStop: true,
                roomInstructor: true,
                searchRooms: true,
                submitAnnouncements: false,
                campusTips: true,
                campusAlerts: true
            }
        },
        [ROLES.EMPLOYEE]: {
            allowedTypes: 'all',
            features: {
                saveLocations: true,
                routeHistory: true,
                multiStop: true,
                roomInstructor: true,
                searchRooms: true,
                submitAnnouncements: true,   // Employees get the new privilege
                campusTips: true,
                campusAlerts: true
            }
        },
        [ROLES.ADMIN]: {
            allowedTypes: 'all',
            features: {
                saveLocations: true,
                routeHistory: true,
                multiStop: true,
                roomInstructor: true,
                searchRooms: true,
                submitAnnouncements: false,
                campusTips: true,
                campusAlerts: true
            },
            isAdmin: true
        }
    };

    function normalizeRole(role) {
        const r = String(role || '').trim().toUpperCase();
        return ROLE_CONFIG[r] ? r : ROLES.VISITOR; // fail-closed: unknown role = most restricted
    }

    function getRoleConfig(role) {
        return ROLE_CONFIG[normalizeRole(role)];
    }

    /** Can this role view/search/navigate to a building of this type? */
    function canAccessLocationType(role, type) {
        const config = getRoleConfig(role);
        if (config.allowedTypes === 'all') return true;
        return config.allowedTypes.includes(type);
    }

    /** Can this role use a given feature flag (e.g. 'saveLocations')? */
    function canUseFeature(role, featureName) {
        const config = getRoleConfig(role);
        return Boolean(config.features && config.features[featureName]);
    }

    function isAdmin(role) {
        const config = getRoleConfig(role);
        return Boolean(config.isAdmin);
    }

    /**
     * Filter a campusData `locations` array down to what this role may see.
     * Does not mutate the input array.
     */
    function filterLocationsByRole(locations, role) {
        if (!Array.isArray(locations)) return [];
        return locations.filter(loc => canAccessLocationType(role, loc.type));
    }

    /**
     * Server-side guard: throws-free boolean check for a building "type"
     * string coming from a DB row (buildings.type) or campusData location.
     */
    function assertLocationTypeAllowed(role, type) {
        return canAccessLocationType(role, type);
    }

    // ── Visitor purpose scope ────────────────────────────────────────────
    // Buildings may come from campusData ({ shortName, name, type }) or from
    // a DB row ({ short_name, name, type }) — both shapes are accepted.

    // Lower-cases and evens out curly quotes/spaces so "Dean’s Office" and
    // "Dean's Office" compare equal.
    function normalizeName(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/[‘’`]/g, "'")
            .replace(/\s+/g, ' ')
            .trim();
    }

    function getVisitPurpose(purpose) {
        return VISIT_PURPOSES.find(p => p.value === purpose) || null;
    }

    // Rules in effect for a purpose: the always-visible places + the
    // purpose's own destinations. No/unknown purpose = always-visible only.
    function getPurposeRules(purpose) {
        const rules = VISITOR_ALWAYS_VISIBLE.map(building => ({ building }));
        const p = getVisitPurpose(purpose);
        if (p) rules.push(...p.destinations);
        return rules;
    }

    function ruleMatchesBuilding(rule, building) {
        if (!building) return false;
        if (rule.building) {
            const target = normalizeName(rule.building);
            return target === normalizeName(building.shortName ?? building.short_name)
                || target === normalizeName(building.name);
        }
        if (rule.buildingType) return building.type === rule.buildingType;
        return false;
    }

    function ruleAllowsRoom(rule, roomName) {
        if (rule.rooms === '*') return true;
        if (Array.isArray(rule.rooms)) {
            const name = normalizeName(roomName);
            return rule.rooms.some(r => normalizeName(r) === name);
        }
        if (rule.roomPattern) return new RegExp(rule.roomPattern, 'i').test(String(roomName || ''));
        return false; // building-only rule
    }

    /** Can a Visitor with this purpose see/navigate to this building? */
    function canVisitorSeeBuilding(purpose, building) {
        return getPurposeRules(purpose).some(rule => {
            if (!ruleMatchesBuilding(rule, building)) return false;
            // A type-wide rule (e.g. all departments) only reveals a building
            // that actually has a matching room, e.g. a Dean's Office.
            if (rule.buildingType && Array.isArray(building.rooms)) {
                return building.rooms.some(r => ruleAllowsRoom(rule, typeof r === 'string' ? r : r?.name));
            }
            return true;
        });
    }

    /** Can a Visitor with this purpose see/navigate to this room of this building? */
    function canVisitorSeeRoom(purpose, building, roomName) {
        return getPurposeRules(purpose).some(rule =>
            ruleMatchesBuilding(rule, building) && ruleAllowsRoom(rule, roomName)
        );
    }

    /**
     * Returns a copy of campusData `locations` containing only the buildings
     * and rooms a Visitor with this purpose may see. Does not mutate input.
     */
    function filterLocationsForPurpose(locations, purpose) {
        if (!Array.isArray(locations)) return [];
        return locations
            .filter(loc => canVisitorSeeBuilding(purpose, loc))
            .map(loc => ({
                ...loc,
                rooms: Array.isArray(loc.rooms)
                    ? loc.rooms.filter(r => canVisitorSeeRoom(purpose, loc, typeof r === 'string' ? r : r?.name))
                    : loc.rooms
            }));
    }

    return {
        ROLES,
        LOCATION_TYPES,
        ROLE_CONFIG,
        VISIT_PURPOSES,
        VISITOR_ALWAYS_VISIBLE,
        VISITOR_EXIT_GATES,
        VISITOR_ACCESS_HOURS,
        normalizeRole,
        getRoleConfig,
        canAccessLocationType,
        canUseFeature,
        isAdmin,
        filterLocationsByRole,
        assertLocationTypeAllowed,
        getVisitPurpose,
        canVisitorSeeBuilding,
        canVisitorSeeRoom,
        filterLocationsForPurpose
    };
});