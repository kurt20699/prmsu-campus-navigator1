require("dotenv").config();
const { Pool } = require("pg");

global.window = global.window || {};
require("./static-footprints.js");
const staticFootprints = global.window.STATIC_BUILDING_FOOTPRINTS || [];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function rand(min, max) {
  return +(Math.random() * (max - min) + min).toFixed(1);
}

// Now returns {lat, lng, buildingId} instead of a plain [lat, lng] pair,
// so each generated tree stays linked back to the footprint it came from.
function generateTreePositionsAroundFootprints(rings) {
  const SPACING_M = 10;
  const OFFSET_M = 2.5;
  const MIN_EDGE_M = 3;
  const positions = [];

  rings.forEach(({ coords: ring, buildingId }) => {
    if (!Array.isArray(ring) || ring.length < 3) return;

    const pts = ring.slice();
    const first = pts[0], last = pts[pts.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) pts.push(first);

    const uniquePts = pts.slice(0, pts.length - 1);
    const centroid = uniquePts
      .reduce((acc, [lat, lng]) => [acc[0] + lat, acc[1] + lng], [0, 0])
      .map((v) => v / uniquePts.length);

    for (let i = 0; i < pts.length - 1; i++) {
      const [latA, lngA] = pts[i];
      const [latB, lngB] = pts[i + 1];
      const midLat = (latA + latB) / 2;

      const dxM = (lngB - lngA) * 111320 * Math.cos((midLat * Math.PI) / 180);
      const dyM = (latB - latA) * 111320;
      const edgeLenM = Math.sqrt(dxM * dxM + dyM * dyM);
      if (edgeLenM < MIN_EDGE_M) continue;

      let nx = -dyM, ny = dxM;
      const norm = Math.sqrt(nx * nx + ny * ny) || 1;
      nx /= norm;
      ny /= norm;

      const midLng = (lngA + lngB) / 2;
      const cLatM = (midLat - centroid[0]) * 111320;
      const cLngM = (midLng - centroid[1]) * 111320 * Math.cos((midLat * Math.PI) / 180);
      if (nx * cLngM + ny * cLatM < 0) {
        nx = -nx;
        ny = -ny;
      }

      const steps = Math.max(1, Math.floor(edgeLenM / SPACING_M));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const lat = latA + (latB - latA) * t;
        const lng = lngA + (lngB - lngA) * t;
        const dLat = (ny * OFFSET_M) / 111320;
        const dLng = (nx * OFFSET_M) / (111320 * Math.cos((lat * Math.PI) / 180));
        positions.push({ lat: lat + dLat, lng: lng + dLng, buildingId });
      }
    }
  });

  return positions;
}

async function seed() {
  const rings = [];

  // Static footprints have no DB building row → building_id stays NULL
  staticFootprints.forEach((fp) => rings.push({ coords: fp.coords, buildingId: null }));

  // Admin-drawn footprints → carry the real building id along
  const dbRes = await pool.query(
    `SELECT id, footprint FROM buildings WHERE footprint IS NOT NULL`
  );
  dbRes.rows.forEach((row) => {
    if (Array.isArray(row.footprint) && row.footprint.length >= 3) {
      rings.push({ coords: row.footprint, buildingId: row.id });
    }
  });

  const positions = generateTreePositionsAroundFootprints(rings);
  let count = 0;
  for (const { lat, lng, buildingId } of positions) {
    // ✅ ADDED — randomized so trees aren't visually identical, plus
    // building_id so trees can be looked up/cleared per-building later.
    const trunkHeight = rand(1.5, 5);
    const canopyHeight = trunkHeight + rand(2, 5); // canopy sits above the trunk
    const canopyRadius = rand(1.2, 4.5);

    await pool.query(
      `INSERT INTO trees (lat, lng, building_id, trunk_height, canopy_height, canopy_radius)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [lat, lng, buildingId, trunkHeight, canopyHeight, canopyRadius]
    );
    count++;
  }

  console.log(`Seeded ${count} trees.`);
  await pool.end();
}

seed().catch((err) => {
  console.error("Tree seed failed:", err);
  process.exit(1);
});