// ==UserScript==
// @name         WikiMasters – Prix moyen sur les cartes
// @namespace    https://github.com/ch4mo/mod_wiki
// @version      1.1.0
// @description  Affiche le prix de vente moyen du marché directement sur chaque carte de la collection.
// @match        https://www.wiki-masters.com/*
// @match        https://wiki-masters.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Le script doit tourner dans le contexte de la page pour lire les réponses de fetch().
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (W.__wmPrixMoyen) return; // déjà injecté (application Android + userscript)
  W.__wmPrixMoyen = true;

  const CACHE_KEY = 'wmPrixMoyenCache.v1';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
  const MAX_PARALLEL = 2;                  // requêtes simultanées max
  const DELAY_MS = 250;                    // pause entre deux requêtes
  const RARITIES = ['L', 'UR', 'SR', 'R', 'PC', 'C'];

  // ---------- Cache des prix (localStorage) ----------
  let cache = {};
  try { cache = JSON.parse(W.localStorage.getItem(CACHE_KEY) || '{}'); } catch (_) { cache = {}; }
  // Supprime les prix expirés pour que le stockage ne grossisse pas indéfiniment.
  for (const id of Object.keys(cache)) {
    if (!cache[id] || Date.now() - cache[id].t >= CACHE_TTL_MS) delete cache[id];
  }
  let saveTimer = null;
  function saveCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { W.localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_) { /* stockage indisponible */ }
    }, 500);
  }
  function cached(cardId) {
    const e = cache[cardId];
    return e && Date.now() - e.t < CACHE_TTL_MS ? e : null;
  }

  // ---------- Correspondance "titre|rareté" -> id de carte ----------
  // Rempli en lisant les réponses de /api/my-collection que le site charge lui-même.
  const index = new Map();
  function learnCollection(json) {
    const list = json && Array.isArray(json.collection) ? json.collection : null;
    if (!list) return;
    for (const item of list) {
      const c = item && item.card;
      if (!c || !c.id || !c.wikipedia_title) continue;
      const key = c.wikipedia_title + '|' + c.rarity;
      const arr = index.get(key) || [];
      if (!arr.some(x => x.id === c.id)) arr.push({ id: c.id, img: c.image_url || '' });
      index.set(key, arr);
    }
    scan();
  }

  const origFetch = W.fetch;
  W.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\/api\/my-collection(\?|$)/.test(url)) {
        p.then(r => r.clone().json()).then(learnCollection).catch(() => {});
      }
    } catch (_) { /* ne jamais casser le site */ }
    return p;
  };

  // ---------- File de requêtes vers le marché ----------
  const queue = [];
  const pending = new Map(); // cardId -> Promise
  let active = 0;

  function fetchAverage(cardId) {
    if (pending.has(cardId)) return pending.get(cardId);
    const pr = new Promise(resolve => queue.push({ cardId, resolve }));
    pending.set(cardId, pr);
    pump();
    return pr;
  }

  function pump() {
    while (active < MAX_PARALLEL && queue.length) {
      const job = queue.shift();
      active++;
      origFetch.call(W, '/api/marketplace/cards/' + encodeURIComponent(job.cardId) + '/sales?scope=summary', { credentials: 'include' })
        .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
        .then(json => {
          const entry = { t: Date.now(), s: (json && json.summary) || {} };
          cache[job.cardId] = entry;
          saveCache();
          job.resolve(entry);
        })
        .catch(() => job.resolve(null))
        .finally(() => {
          pending.delete(job.cardId);
          setTimeout(() => { active--; pump(); }, DELAY_MS);
        });
    }
  }

  // ---------- Affichage ----------
  const STYLE = `
    .wm-prix{position:absolute;left:6px;top:calc(45% - 26px);z-index:40;
      padding:2px 7px;border-radius:999px;font:700 12px/18px system-ui,sans-serif;
      background:rgba(10,14,18,.82);color:#34d399;box-shadow:0 1px 4px rgba(0,0,0,.5);
      pointer-events:none;white-space:nowrap}
    .wm-prix.wm-vide{color:#9ca3af}
    .wm-prix.wm-charge{color:#9ca3af;opacity:.7}`;
  function injectStyle() {
    if (document.getElementById('wm-prix-style')) return;
    const s = document.createElement('style');
    s.id = 'wm-prix-style';
    s.textContent = STYLE;
    (document.head || document.documentElement).appendChild(s);
  }

  function badgeFor(cardEl) {
    let b = cardEl.querySelector(':scope > .wm-prix');
    if (!b) {
      b = document.createElement('div');
      b.className = 'wm-prix';
      cardEl.appendChild(b);
    }
    return b;
  }

  function render(cardEl, rarity, entry) {
    const b = badgeFor(cardEl);
    if (!entry) { b.className = 'wm-prix wm-vide'; b.textContent = 'Ⓦ ?'; return; }
    const avg = entry.s[rarity] && entry.s[rarity].average;
    if (avg == null) { b.className = 'wm-prix wm-vide'; b.textContent = 'Ⓦ –'; b.title = 'Aucune vente récente'; return; }
    b.className = 'wm-prix';
    b.textContent = 'Ⓦ ' + Math.round(avg).toLocaleString('fr-FR');
  }

  // Une carte de la grille = bloc arrondi contenant un <h3> (titre) et un badge de rareté.
  function readCard(cardEl) {
    const h3 = cardEl.querySelector('h3');
    if (!h3) return null;
    const title = h3.textContent.trim();
    let rarity = null;
    for (const el of cardEl.querySelectorAll('div')) {
      const t = el.childElementCount === 0 ? el.textContent.trim() : '';
      if (RARITIES.includes(t)) { rarity = t; break; }
    }
    if (!title || !rarity) return null;
    const ids = index.get(title + '|' + rarity);
    if (!ids || !ids.length) return null;
    let id = ids[0].id;
    if (ids.length > 1) {
      const imgs = [...cardEl.querySelectorAll('img')].map(i => i.getAttribute('src') || '');
      const hit = ids.find(x => x.img && imgs.includes(x.img));
      if (hit) id = hit.id;
    }
    return { id, rarity, key: id + '|' + rarity };
  }

  const io = 'IntersectionObserver' in W ? new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      process(e.target);
    }
  }, { rootMargin: '300px' }) : null;

  function process(cardEl) {
    const info = readCard(cardEl);
    if (!info) return;
    cardEl.dataset.wmKey = info.key;
    const hit = cached(info.id);
    if (hit) { render(cardEl, info.rarity, hit); return; }
    const b = badgeFor(cardEl);
    b.className = 'wm-prix wm-charge';
    b.textContent = 'Ⓦ …';
    fetchAverage(info.id).then(entry => {
      if (cardEl.dataset.wmKey === info.key) render(cardEl, info.rarity, entry);
    });
  }

  function scan() {
    if (!document.body) return;
    injectStyle();
    for (const h3 of document.querySelectorAll('div.rounded-2xl.cursor-pointer h3')) {
      const cardEl = h3.closest('div.rounded-2xl.cursor-pointer');
      if (!cardEl) continue;
      const info = readCard(cardEl);
      if (!info) continue;
      if (cardEl.dataset.wmKey === info.key) continue; // déjà traité
      cardEl.dataset.wmKey = '';
      if (io) io.observe(cardEl); else process(cardEl);
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 150);
  }

  function start() {
    injectStyle();
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true, characterData: true });
    scan();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
