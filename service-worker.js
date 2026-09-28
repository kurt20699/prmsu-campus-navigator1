const CACHE_NAME = 'prmsu-navigator-v10';
const TILE_CACHE_NAME = 'prmsu-map-tiles-v4';

// App shell files to cache immediately
const APP_SHELL = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './permissions.js',
    './campus-data.js',
    './static-footprints.js',
    './location-filter.js',
    './campus-tips.js',
    './visitor-purpose.js',
    './voice-navigation.js',
    './weather-widget.js',
];

// Install - cache app shell
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('Caching app shell...');
            return cache.addAll(APP_SHELL);
        })
    );
    self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME && key !== TILE_CACHE_NAME)
                    .map(key => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// Fetch - serve from cache or network
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Handle map tile requests (OpenStreetMap)
    if (url.hostname.includes('tile.openstreetmap.org') || url.hostname.includes('tiles.openfreemap.org')) {
        event.respondWith(
            caches.open(TILE_CACHE_NAME).then(cache => {
                return cache.match(event.request).then(cached => {
                    if (cached) {
                        return cached; // Serve from cache
                    }
                    // Fetch and cache the tile
                    return fetch(event.request).then(response => {
                        if (response.ok) {
                            cache.put(event.request, response.clone());
                        }
                        return response;
                    }).catch(() => {
                        // ✅ Return a PROPER 204 No Content instead of a fake
                        // 200 with an empty body. The old empty Response('', 200)
                        // was treated as a valid tile by MapLibre (response.ok = true)
                        // and written to the tile cache — meaning a tile that failed
                        // to load during one session would permanently serve as a blank
                        // tile on every subsequent request, including after switching
                        // back from Satellite view. A 204 signals "no data" without
                        // being cacheable, so MapLibre will retry the real tile on the
                        // next opportunity instead of keeping the blank cached forever.
                        return new Response(null, { status: 204 });
                    });
                });
            })
        );
        return;
    }

    // ✅ ADD — Always hit the network for API calls. These return dynamic
    // data (building/room counts, users, announcements, etc.) and must
    // never be served from cache — otherwise the first fetch of e.g.
    // /api/buildings gets cached, and every later request for that same
    // URL (including after logging out and back in) silently returns
    // that old snapshot instead of the current DB state.
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(fetch(event.request));
        return;
    }


    // Always prefer network for index/admin to avoid stale login/app shell state
    if (url.pathname.endsWith('/index.html') || url.pathname.endsWith('/admin.html') || url.pathname === '/' || url.pathname.endsWith('/Software_Engineering_II/')) {
        event.respondWith(
            fetch(event.request).then(response => {
                if (response.ok) {
                    const cacheKey = url.pathname.endsWith('/admin.html') ? './admin.html' : './index.html';
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, responseClone));
                }
                return response;
            }).catch(() => caches.match(url.pathname.endsWith('/admin.html') ? './admin.html' : './index.html'))
        );
        return;
    }

    // JS/CSS must always be checked against the network first, same as
    // index.html — otherwise edits to these files get silently ignored
    // by returning users until the cache is manually busted (e.g. hard
    // refresh), which is confusing during active development.
    if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
        event.respondWith(
            fetch(event.request).then(response => {
                if (response.ok) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
                }
                return response;
            }).catch(() => caches.match(event.request))
        );
        return;
    }

    // Handle remaining app shell requests (images, icons, fonts, etc.)
    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) {
                return cached; // Serve from cache
            }
            return fetch(event.request).then(response => {
                // Cache successful responses
                if (response.ok) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseClone);
                    });
                }
                return response;
            }).catch(() => {
                // If offline and not cached, return index.html
                return caches.match('./index.html');
            });
        })
    );
});