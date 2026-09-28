    /**
     * seed-from-campus-data.js
     * One-time (or repeatable) seed: wipes buildings/rooms and repopulates them
     * from campus-data.js — the actual source of truth — instead of the stale
     * hardcoded arrays that used to live in server.js.
     *
     * Usage: node seed-from-campus-data.js
     */
    require("dotenv").config();
    const { Pool } = require("pg");
    const campusData = require("./campus-data.js");

    const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL,
    ssl: { rejectUnauthorized: false }
    });

    async function seed() {
    let buildingCount = 0;
    let roomCount = 0;
    let skippedBuildings = 0;
    let skippedRooms = 0;

    // ✅ Don't wipe existing buildings — that also destroys any admin-drawn
    // footprint/color data, since campus-data.js never had footprints to
    // begin with. Only insert buildings that aren't already in the DB.
    const existingRes = await pool.query("SELECT short_name FROM buildings");
    const existingShortNames = new Set(existingRes.rows.map(r => r.short_name));

    for (const campusKey of Object.keys(campusData)) {
        const campus = campusData[campusKey];
        if (!campus.locations) continue;

        for (const loc of campus.locations) {
        if (existingShortNames.has(loc.shortName)) {
            continue; // already in DB — skip so its footprint/color is preserved
        }
        const [lat, lng] = loc.coords || [null, null];

        // ── Insert building — isolated so one bad row doesn't kill the whole seed ──
        try {
            await pool.query(
            `INSERT INTO buildings (name, short_name, type, lat, lng) VALUES ($1,$2,$3,$4,$5)`,
            [loc.name, loc.shortName, loc.type, lat, lng]
            );
            buildingCount++;
        } catch (err) {
            console.warn(`⚠️  Skipped building "${loc.name}" (${loc.shortName}): ${err.message}`);
            skippedBuildings++;
            continue; // don't attempt rooms for a building that failed to insert
        }

        if (Array.isArray(loc.rooms)) {
            for (const room of loc.rooms) {
            try {
                if (typeof room === "string") {
                // Some entries (Registrar, Library, GAD, Cafeteria, Clinic, Dormitory,
                // Cooperative Canteen) list rooms as plain name strings with no coords.
                // floor is NOT NULL in the schema, so default to '—' — same convention
                // your existing /api/admin/rooms route already uses.
                await pool.query(
                    `INSERT INTO rooms (building, name, floor, lat, lng) VALUES ($1,$2,$3,$4,$5)`,
                    [loc.shortName, room, "—", null, null]
                );
                } else {
                const [rLat, rLng] = room.coords || [null, null];
                const [offX, offY] = room.iconOffset || [0, 0];
                await pool.query(
                    `INSERT INTO rooms (building, name, floor, instructor, lat, lng, icon_offset_x, icon_offset_y)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                    [loc.shortName, room.name, room.floor || "—", room.instructor || null, rLat, rLng, offX, offY]
                );
                }
                roomCount++;
            } catch (err) {
                const roomName = typeof room === "string" ? room : room.name;
                console.warn(`⚠️  Skipped room "${roomName}" in "${loc.shortName}": ${err.message}`);
                skippedRooms++;
            }
            }
        }
        }
    }

    console.log(`\nSeeded ${buildingCount} buildings, ${roomCount} rooms.`);
    if (skippedBuildings || skippedRooms) {
        console.log(`Skipped ${skippedBuildings} buildings, ${skippedRooms} rooms — see warnings above.`);
    }
    await pool.end();
    }

    seed().catch(err => {
    console.error("Seed failed:", err);
    process.exit(1);
    });