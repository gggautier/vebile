'use strict';

// ── Config ─────────────────────────────────────────────────────────────────────
const API_URL    = 'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/velib-disponibilite-en-temps-reel/records';
const PAGE_SIZE  = 5;
const GEO_RADIUS = 5000; // mètres

// ── État ───────────────────────────────────────────────────────────────────────
let userLat        = null;
let userLon        = null;
let compassHeading = null;
let stations       = [];
let displayedCount = 0;
let loading        = false;

// ── DOM ────────────────────────────────────────────────────────────────────────
const $list      = document.getElementById('station-list');
const $loader    = document.getElementById('scroll-loader');
const $refresh   = document.getElementById('btn-refresh');
const $geoDenied = document.getElementById('screen-geo-denied');
const $error     = document.getElementById('screen-error');
const $errorMsg  = document.getElementById('error-message');
const $container = document.getElementById('station-container');

// ── Géolocalisation ────────────────────────────────────────────────────────────
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(Object.assign(new Error('no-geo'), { code: 0 }));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000,
    });
  });
}

// ── Boussole ───────────────────────────────────────────────────────────────────
function setupCompass() {
  function onOrientation(e) {
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading !== null) {
      // iOS : heading direct (0 = Nord, sens horaire)
      compassHeading = e.webkitCompassHeading;
    } else if (e.alpha !== null) {
      // Android : alpha est CCW depuis Nord → on inverse
      compassHeading = (360 - e.alpha + 360) % 360;
    }
    updateArrows();
  }

  if (
    typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function'
  ) {
    // iOS 13+ : permission requise au premier geste utilisateur
    document.addEventListener('click', async () => {
      try {
        const perm = await DeviceOrientationEvent.requestPermission();
        if (perm === 'granted') window.addEventListener('deviceorientation', onOrientation, true);
      } catch (_) {}
    }, { once: true });
  } else {
    window.addEventListener('deviceorientation', onOrientation, true);
  }
}

// ── Maths ──────────────────────────────────────────────────────────────────────

/** Distance Haversine en mètres. */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Relèvement (bearing) de pos1 → pos2, degrés, 0 = Nord, sens horaire. */
function calcBearing(lat1, lon1, lat2, lon2) {
  const r    = Math.PI / 180;
  const dLon = (lon2 - lon1) * r;
  const y    = Math.sin(dLon) * Math.cos(lat2 * r);
  const x    =
    Math.cos(lat1 * r) * Math.sin(lat2 * r) -
    Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dLon);
  return (Math.atan2(y, x) / r + 360) % 360;
}

/** Formate une distance en mètres (ex: "489 m" ou "1.2 km"). */
function fmtDist(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

// ── API Vélib ──────────────────────────────────────────────────────────────────
async function fetchStations() {
  // Filtre géographique + tri par distance côté serveur
  const where   = `distance(coordonnees_geo,geom'POINT(${userLon} ${userLat})',${GEO_RADIUS}m)`;
  const orderBy = `distance(coordonnees_geo,geom'POINT(${userLon} ${userLat})')`;
  const url     = `${API_URL}?limit=100&where=${encodeURIComponent(where)}&order_by=${encodeURIComponent(orderBy)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Erreur réseau (HTTP ${res.status})`);

  const { results = [] } = await res.json();

  return results
    .filter(s => s.coordonnees_geo?.lat && s.coordonnees_geo?.lon)
    .map(s => ({
      name:       s.name || s.stationcode || '—',
      lat:        s.coordonnees_geo.lat,
      lon:        s.coordonnees_geo.lon,
      mechanical: s.mechanical        ?? 0,
      ebike:      s.ebike             ?? 0,
      docks:      s.numdocksavailable ?? 0,
      dist:       haversine(userLat, userLon, s.coordonnees_geo.lat, s.coordonnees_geo.lon),
      bear:       calcBearing(userLat, userLon, s.coordonnees_geo.lat, s.coordonnees_geo.lon),
    }))
    .sort((a, b) => a.dist - b.dist);
}

// ── Rendu ──────────────────────────────────────────────────────────────────────

/** Échappe les caractères HTML. */
function esc(str) {
  return String(str).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/**
 * Icône flèche de navigation — path extrait du composant icon-compass Figma.
 * Pointe vers le Nord par défaut. La rotation CSS oriente vers la station.
 */
function arrowSVG(deg) {
  return `<svg class="nav-arrow"
    style="transform:rotate(${deg}deg)"
    width="14" height="18"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true">
    <path d="M12 2L5 19.3274L5.66267 20L12 17.1579L18.3373 20L19 19.3274L12 2Z" fill="black"/>
  </svg>`;
}

function cardHTML(s) {
  const arrowDeg = compassHeading !== null ? s.bear - compassHeading : 0;
  const mapsHref = `https://www.google.com/maps/dir/?api=1&origin=${userLat},${userLon}&destination=${s.lat},${s.lon}&travelmode=walking`;

  return `
    <div class="station-card" role="listitem" data-bearing="${s.bear}">
      <div class="card-inner">

        <div class="card-left">
          <p class="station-name" title="${esc(s.name)}">${esc(s.name)}</p>
          <div class="badges">
            <span class="badge badge--green" title="Vélos mécaniques disponibles">${s.mechanical}</span>
            <span class="badge badge--blue"  title="Vélos électriques disponibles">${s.ebike}</span>
            <span class="badge badge--gray"  title="Emplacements libres">${s.docks}</span>
          </div>
        </div>

        <a class="nav-btn"
           href="${mapsHref}"
           target="_blank"
           rel="noopener noreferrer"
           aria-label="Naviguer vers ${esc(s.name)} — ${fmtDist(s.dist)} à pied">
          ${arrowSVG(arrowDeg)}
          <span class="nav-dist">${fmtDist(s.dist)}</span>
        </a>

      </div>
      <hr class="card-sep">
    </div>`;
}

function skeletonHTML() {
  return Array(PAGE_SIZE).fill(`
    <div class="station-card" aria-hidden="true">
      <div class="card-inner">
        <div class="card-left">
          <div class="skel skel-name"></div>
          <div class="skel-badges">
            <div class="skel skel-badge"></div>
            <div class="skel skel-badge"></div>
            <div class="skel skel-badge"></div>
          </div>
        </div>
        <div class="skel skel-nav"></div>
      </div>
      <hr class="card-sep">
    </div>`).join('');
}

async function renderMore() {
  if (loading || displayedCount >= stations.length) return;
  loading = true;
  $loader.hidden = false;
  // Double rAF : laisse le navigateur peindre le loader avant l'insertion DOM
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const slice = stations.slice(displayedCount, displayedCount + PAGE_SIZE);
  slice.forEach(s => $list.insertAdjacentHTML('beforeend', cardHTML(s)));
  displayedCount += slice.length;
  $loader.hidden = true;
  loading = false;
}

function updateArrows() {
  if (compassHeading === null) return;
  document.querySelectorAll('.station-card[data-bearing]').forEach(card => {
    const deg   = parseFloat(card.dataset.bearing) - compassHeading;
    const arrow = card.querySelector('.nav-arrow');
    if (arrow) arrow.style.transform = `rotate(${deg}deg)`;
  });
}

// ── États UI ───────────────────────────────────────────────────────────────────
function showSkeletons() {
  $geoDenied.hidden = true;
  $error.hidden     = true;
  $loader.hidden    = true;
  $list.innerHTML   = skeletonHTML();
}

function showGeoDenied() {
  $list.innerHTML   = '';
  $loader.hidden    = true;
  $geoDenied.hidden = false;
  $error.hidden     = true;
}

function showError(msg) {
  $list.innerHTML       = '';
  $loader.hidden        = true;
  $error.hidden         = false;
  $geoDenied.hidden     = true;
  $errorMsg.textContent = msg || 'Impossible de charger les données.';
}

// ── Chargement ─────────────────────────────────────────────────────────────────
async function loadStations() {
  if (loading) return;
  loading = true;
  showSkeletons();
  try {
    stations        = await fetchStations();
    $list.innerHTML = '';
    displayedCount  = 0;
    loading = false; // libérer avant renderMore qui gère son propre flag
    await renderMore();
  } catch (e) {
    loading = false;
    showError(e.message);
  }
}

async function init() {
  setupCompass();
  showSkeletons();
  try {
    const pos = await getPosition();
    userLat   = pos.coords.latitude;
    userLon   = pos.coords.longitude;
    await loadStations();
  } catch (e) {
    if (e.code === 1 || e.message === 'no-geo') showGeoDenied();
    else showError('Impossible d\'accéder à votre position.');
  }
}

// ── Événements ─────────────────────────────────────────────────────────────────

// Infinite scroll : déclenche renderMore à 100px avant la fin du container
$container.addEventListener('scroll', () => {
  if (loading || displayedCount >= stations.length) return;
  const { scrollTop, scrollHeight, clientHeight } = $container;
  if (scrollHeight - scrollTop - clientHeight < 100) {
    renderMore();
  }
}, { passive: true });

$refresh.addEventListener('click', async () => {
  if (loading) return;
  $refresh.classList.add('is-spinning');
  try {
    const pos = await getPosition();
    userLat   = pos.coords.latitude;
    userLon   = pos.coords.longitude;
    await loadStations();
    $container.scrollTop = 0;
  } catch (e) {
    showError('Impossible d\'accéder à votre position.');
  } finally {
    $refresh.classList.remove('is-spinning');
  }
});

document.getElementById('btn-retry-geo').addEventListener('click', () => {
  location.reload();
});

// ── Démarrage ──────────────────────────────────────────────────────────────────
init();
