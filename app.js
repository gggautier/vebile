'use strict';

// ── Config ─────────────────────────────────────────────────────────────────────
const API_URL          = 'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/velib-disponibilite-en-temps-reel/records';
const GEOCODE_REVERSE  = 'https://api-adresse.data.gouv.fr/reverse/';
const GEOCODE_SEARCH   = 'https://api-adresse.data.gouv.fr/search/';
const PAGE_SIZE        = 5;
const GEO_RADIUS       = 5000; // mètres

// ── État ───────────────────────────────────────────────────────────────────────
let userLat        = null;
let userLon        = null;
let compassHeading = null;
let stations       = [];
let displayedCount = 0;
let loading        = false;
let currentMode    = 'borrow'; // 'borrow' | 'return'
let searchTimer    = null;

// ── DOM ────────────────────────────────────────────────────────────────────────
const $list          = document.getElementById('station-list');
const $loader        = document.getElementById('scroll-loader');
const $geoDenied     = document.getElementById('screen-geo-denied');
const $error         = document.getElementById('screen-error');
const $errorMsg      = document.getElementById('error-message');
const $container     = document.getElementById('station-container');
const $locationText  = document.getElementById('location-text');
const $btnLocOpen    = document.getElementById('btn-location-open');
const $btnRefresh    = document.getElementById('btn-refresh');
const $modal         = document.getElementById('search-modal');
const $modalBack     = document.getElementById('btn-modal-back');
const $searchInput   = document.getElementById('search-input');
const $btnUseGPS     = document.getElementById('btn-use-gps');
const $searchResults = document.getElementById('search-results');
const $tabBorrow     = document.getElementById('tab-borrow');
const $tabReturn     = document.getElementById('tab-return');
const $tabbar        = document.getElementById('tabbar');

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

// ── Géocodage inverse (GPS → adresse) ─────────────────────────────────────────
async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(`${GEOCODE_REVERSE}?lon=${lon}&lat=${lat}&limit=1`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.features?.[0]?.properties?.label ?? null;
  } catch {
    return null;
  }
}

// ── Autocomplétion d'adresse ───────────────────────────────────────────────────
async function searchAddress(query) {
  try {
    const res = await fetch(`${GEOCODE_SEARCH}?q=${encodeURIComponent(query)}&limit=5`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.features ?? [];
  } catch {
    return [];
  }
}

// ── Boussole ───────────────────────────────────────────────────────────────────
function setupCompass() {
  function onOrientation(e) {
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading !== null) {
      compassHeading = e.webkitCompassHeading;
    } else if (e.alpha !== null) {
      compassHeading = (360 - e.alpha + 360) % 360;
    }
    updateArrows();
  }

  if (
    typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function'
  ) {
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
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcBearing(lat1, lon1, lat2, lon2) {
  const r    = Math.PI / 180;
  const dLon = (lon2 - lon1) * r;
  const y    = Math.sin(dLon) * Math.cos(lat2 * r);
  const x    =
    Math.cos(lat1 * r) * Math.sin(lat2 * r) -
    Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dLon);
  return (Math.atan2(y, x) / r + 360) % 360;
}

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

// ── API Vélib ──────────────────────────────────────────────────────────────────
async function fetchStations() {
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
function esc(str) {
  return String(str).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function arrowSVG(deg) {
  return `<svg class="nav-arrow"
    style="transform:rotate(${deg}deg)"
    width="14" height="18" viewBox="0 0 24 24" fill="none"
    xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M12 2L5 19.3274L5.66267 20L12 17.1579L18.3373 20L19 19.3274L12 2Z" fill="black"/>
  </svg>`;
}

function cardHTML(s) {
  const arrowDeg = compassHeading !== null ? s.bear - compassHeading : 0;
  const mapsHref = `https://www.google.com/maps/dir/?api=1&origin=${userLat},${userLon}&destination=${s.lat},${s.lon}&travelmode=walking`;
  const navBtn   = `
    <a class="nav-btn"
       href="${mapsHref}"
       target="_blank"
       rel="noopener noreferrer"
       aria-label="Naviguer vers ${esc(s.name)} — ${fmtDist(s.dist)} à pied">
      ${arrowSVG(arrowDeg)}
      <span class="nav-dist">${fmtDist(s.dist)}</span>
    </a>`;

  if (currentMode === 'return') {
    return `
      <div class="station-card" role="listitem" data-bearing="${s.bear}">
        <div class="card-inner card-inner--return">
          <span class="badge badge--gray" title="Emplacements libres">${s.docks}</span>
          <p class="station-name station-name--return" title="${esc(s.name)}">${esc(s.name)}</p>
          ${navBtn}
        </div>
        <hr class="card-sep">
      </div>`;
  }

  // Mode Emprunter (défaut) — badges vert + bleu uniquement
  return `
    <div class="station-card" role="listitem" data-bearing="${s.bear}">
      <div class="card-inner">
        <div class="card-left">
          <p class="station-name" title="${esc(s.name)}">${esc(s.name)}</p>
          <div class="badges">
            <span class="badge badge--green" title="Vélos mécaniques disponibles">${s.mechanical}</span>
            <span class="badge badge--blue"  title="Vélos électriques disponibles">${s.ebike}</span>
          </div>
        </div>
        ${navBtn}
      </div>
      <hr class="card-sep">
    </div>`;
}

function skeletonHTML() {
  if (currentMode === 'return') {
    return Array(PAGE_SIZE).fill(`
      <div class="station-card" aria-hidden="true">
        <div class="card-inner card-inner--return">
          <div class="skel skel-badge"></div>
          <div class="skel" style="flex:1;height:24px;margin:0"></div>
          <div class="skel skel-nav"></div>
        </div>
        <hr class="card-sep">
      </div>`).join('');
  }
  return Array(PAGE_SIZE).fill(`
    <div class="station-card" aria-hidden="true">
      <div class="card-inner">
        <div class="card-left">
          <div class="skel skel-name"></div>
          <div class="skel-badges">
            <div class="skel skel-badge"></div>
            <div class="skel skel-badge"></div>
          </div>
        </div>
        <div class="skel skel-nav"></div>
      </div>
      <hr class="card-sep">
    </div>`).join('');
}

// Rendu direct d'un batch (sans loader, pour le changement de mode)
function renderBatch() {
  const slice = stations.slice(displayedCount, displayedCount + PAGE_SIZE);
  slice.forEach(s => $list.insertAdjacentHTML('beforeend', cardHTML(s)));
  displayedCount += slice.length;
}

async function renderMore() {
  if (loading || displayedCount >= stations.length) return;
  loading = true;
  $loader.hidden = false;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  renderBatch();
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

// ── Modale de recherche ────────────────────────────────────────────────────────
function openModal() {
  $modal.classList.add('is-open');
  setTimeout(() => $searchInput.focus(), 50);
}

function closeModal() {
  $modal.classList.remove('is-open');
  $searchInput.value       = '';
  $searchResults.innerHTML = '';
  $searchInput.blur();
}

function renderSearchResults(features) {
  $searchResults.innerHTML = '';
  features.forEach(f => {
    const props    = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const btn      = document.createElement('button');
    btn.className  = 'search-result-btn';
    btn.setAttribute('role', 'option');
    btn.innerHTML  = `
      <!-- icon-32-pin extrait de Figma — 32×32, fill_YD0M1H (#BFBEC2) -->
      <svg class="result-pin" width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M16 10C18.6234 10 20.75 12.1266 20.75 14.75C20.75 17.3734 18.6234 19.5 16 19.5C13.3766 19.5 11.25 17.3734 11.25 14.75C11.25 12.1266 13.3766 10 16 10ZM16 11.5C14.2051 11.5 12.75 12.9551 12.75 14.75C12.75 16.5449 14.2051 18 16 18C17.7949 18 19.25 16.5449 19.25 14.75C19.25 12.9551 17.7949 11.5 16 11.5Z" fill="currentColor"/>
        <path fill-rule="evenodd" clip-rule="evenodd" d="M16 4C18.8511 4 21.5855 5.13242 23.6016 7.14844C25.6176 9.16445 26.75 11.8989 26.75 14.75C26.75 19.5199 24.1093 23.6928 21.5664 26.6172C20.2858 28.0899 19.0062 29.2723 18.0479 30.0869C17.5682 30.4946 17.1673 30.8114 16.8848 31.0273C16.7435 31.1353 16.6321 31.2189 16.5547 31.2754C16.5161 31.3036 16.4858 31.3249 16.4648 31.3398C16.4544 31.3473 16.4462 31.3533 16.4404 31.3574C16.4376 31.3594 16.4353 31.3611 16.4336 31.3623L16.4316 31.3633L16.4307 31.3643C16.4304 31.3644 16.4275 31.3607 16 30.75L16.4307 31.3643C16.1725 31.5448 15.8285 31.5448 15.5703 31.3643L16 30.75C15.5725 31.3607 15.5706 31.3644 15.5703 31.3643L15.5664 31.3623C15.5647 31.3611 15.5624 31.3594 15.5596 31.3574C15.5538 31.3533 15.5456 31.3473 15.5352 31.3398C15.5142 31.3249 15.4839 31.3036 15.4453 31.2754C15.3679 31.2189 15.2565 31.1353 15.1152 31.0273C14.8327 30.8114 14.4318 30.4946 13.9521 30.0869C12.9938 29.2723 11.7142 28.0899 10.4336 26.6172C7.89071 23.6928 5.25 19.5199 5.25 14.75C5.25 11.8989 6.38242 9.16445 8.39844 7.14844C10.4145 5.13242 13.1489 4 16 4ZM16 5.5C13.5467 5.5 11.1937 6.47427 9.45898 8.20898C7.72427 9.9437 6.75 12.2967 6.75 14.75C6.75 18.98 9.10934 22.8072 11.5664 25.6328C12.7857 27.0349 14.0063 28.1653 14.9229 28.9443C15.3658 29.3209 15.737 29.6138 16 29.8154C16.263 29.6138 16.6342 29.3209 17.0771 28.9443C17.9937 28.1653 19.2143 27.0349 20.4336 25.6328C22.8907 22.8072 25.25 18.98 25.25 14.75C25.25 12.2967 24.2757 9.9437 22.541 8.20898C20.8063 6.47427 18.4533 5.5 16 5.5Z" fill="currentColor"/>
      </svg>
      <div class="result-text">
        <span class="result-name">${esc(props.name || props.label || '')}</span>
        <span class="result-city">${esc(props.city || props.context || '')}</span>
      </div>`;
    btn.addEventListener('click', async () => {
      userLat = lat;
      userLon = lon;
      $locationText.textContent = props.label || props.name || 'Adresse sélectionnée';
      closeModal();
      $container.scrollTop = 0;
      await loadStations();
    });
    $searchResults.appendChild(btn);
  });
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
    loading = false;
    await renderMore();
  } catch (e) {
    loading = false;
    showError(e.message);
  }
}

async function refreshGPS() {
  if (loading) return;
  $btnRefresh.classList.add('is-spinning');
  try {
    const pos = await getPosition();
    userLat   = pos.coords.latitude;
    userLon   = pos.coords.longitude;
    // Reverse geocoding en parallèle du chargement
    reverseGeocode(userLat, userLon).then(label => {
      if (label) $locationText.textContent = label;
    });
    await loadStations();
    $container.scrollTop = 0;
  } catch (e) {
    showError('Impossible d\'accéder à votre position.');
  } finally {
    $btnRefresh.classList.remove('is-spinning');
  }
}

async function init() {
  setupCompass();
  showSkeletons();
  try {
    const pos = await getPosition();
    userLat   = pos.coords.latitude;
    userLon   = pos.coords.longitude;
    // Reverse geocoding + chargement stations en parallèle
    const [label] = await Promise.all([
      reverseGeocode(userLat, userLon),
      loadStations(),
    ]);
    if (label) $locationText.textContent = label;
  } catch (e) {
    if (e.code === 1 || e.message === 'no-geo') showGeoDenied();
    else showError('Impossible d\'accéder à votre position.');
  }
}

// ── Événements ─────────────────────────────────────────────────────────────────

// Infinite scroll
$container.addEventListener('scroll', () => {
  if (loading || displayedCount >= stations.length) return;
  const { scrollTop, scrollHeight, clientHeight } = $container;
  if (scrollHeight - scrollTop - clientHeight < 100) renderMore();
}, { passive: true });

// Localisation — ouvrir modale
$btnLocOpen.addEventListener('click', openModal);

// Refresh inline (stopPropagation pour ne pas déclencher la zone de tap)
$btnRefresh.addEventListener('click', e => {
  e.stopPropagation();
  refreshGPS();
});

// Modale — fermer
$modalBack.addEventListener('click', closeModal);

// Modale — utiliser GPS
$btnUseGPS.addEventListener('click', async () => {
  closeModal();
  await refreshGPS();
});

// Modale — autocomplétion (debounce 300 ms)
$searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $searchInput.value.trim();
  if (!q) { $searchResults.innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    const features = await searchAddress(q);
    renderSearchResults(features);
  }, 300);
});

// Tabbar — Emprunter
$tabBorrow.addEventListener('click', () => {
  if (currentMode === 'borrow') return;
  currentMode = 'borrow';
  $tabbar.classList.remove('mode-return');
  $tabBorrow.classList.add('is-active');
  $tabBorrow.setAttribute('aria-selected', 'true');
  $tabReturn.classList.remove('is-active');
  $tabReturn.setAttribute('aria-selected', 'false');
  if (stations.length) {
    $list.innerHTML = '';
    displayedCount  = 0;
    renderBatch();
  }
});

// Tabbar — Déposer
$tabReturn.addEventListener('click', () => {
  if (currentMode === 'return') return;
  currentMode = 'return';
  $tabbar.classList.add('mode-return');
  $tabReturn.classList.add('is-active');
  $tabReturn.setAttribute('aria-selected', 'true');
  $tabBorrow.classList.remove('is-active');
  $tabBorrow.setAttribute('aria-selected', 'false');
  if (stations.length) {
    $list.innerHTML = '';
    displayedCount  = 0;
    renderBatch();
  }
});

// Geo denied — retry
document.getElementById('btn-retry-geo').addEventListener('click', () => {
  location.reload();
});

// ── Démarrage ──────────────────────────────────────────────────────────────────
init();
