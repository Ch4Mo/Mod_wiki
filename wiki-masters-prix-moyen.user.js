// ==UserScript==
// @name         WikiMasters – Prix moyen sur les cartes
// @namespace    https://github.com/ch4mo/mod_wiki
// @version      1.2.0
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
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours
  const MAX_PARALLEL = 2;                  // requêtes simultanées max (cartes à l'écran)
  const DELAY_MS = 250;                    // pause entre deux requêtes (cartes à l'écran)

  // Actualisation de fond : parcourt toute la collection tranquillement.
  const BG_ENABLED = true;
  const BG_DELAY_MS = 2000;                  // 1 requête toutes les 2 s
  const BG_LIST_TTL_MS = 24 * 60 * 60 * 1000; // relit la liste des cartes 1 fois par jour
  const BG_RECHECK_MS = 60 * 60 * 1000;      // revérifie toutes les heures quand tout est à jour
  const BG_START_DELAY_MS = 5000;            // laisse le site se charger d'abord
  const LIST_KEY = 'wmPrixMoyenListe.v1';
  const LOCK_KEY = 'wmPrixMoyenVerrou.v1';
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

  // Interroge le marché pour une carte. Résout { entry, status } (entry = null en cas d'échec).
  function requestSummary(cardId) {
    return origFetch.call(W, '/api/marketplace/cards/' + encodeURIComponent(cardId) + '/sales?scope=summary', { credentials: 'include' })
      .then(r => {
        if (!r.ok) return { entry: null, status: r.status };
        return r.json().then(json => {
          const entry = { t: Date.now(), s: (json && json.summary) || {} };
          cache[cardId] = entry;
          saveCache();
          return { entry, status: r.status };
        });
      })
      .catch(() => ({ entry: null, status: 0 }));
  }

  function pump() {
    while (active < MAX_PARALLEL && queue.length) {
      const job = queue.shift();
      active++;
      requestSummary(job.cardId).then(res => {
        job.resolve(res.entry);
        pending.delete(job.cardId);
        setTimeout(() => { active--; pump(); }, DELAY_MS);
      });
    }
  }

  // ---------- Actualisation de fond ----------
  // Tourne tant que le site est ouvert (pas besoin de faire défiler). La progression est
  // conservée : si l'application est fermée, elle reprend là où elle en était.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tabId = Math.random().toString(36).slice(2);
  let bgBackoff = BG_DELAY_MS;

  function takeLock() {
    // Évite deux actualisations en parallèle (plusieurs onglets).
    try {
      const l = JSON.parse(W.localStorage.getItem(LOCK_KEY) || 'null');
      if (l && l.id !== tabId && Date.now() - l.t < 30000) return false;
      W.localStorage.setItem(LOCK_KEY, JSON.stringify({ id: tabId, t: Date.now() }));
      return true;
    } catch (_) { return true; }
  }

  function loadList() {
    try {
      const l = JSON.parse(W.localStorage.getItem(LIST_KEY) || 'null');
      return l && Array.isArray(l.ids) && Date.now() - l.t < BG_LIST_TTL_MS ? l.ids : null;
    } catch (_) { return null; }
  }

  // Attend que les cartes affichées à l'écran soient servies en priorité.
  async function waitIdle() {
    while (queue.length || active) await sleep(500);
  }

  async function readWholeCollection() {
    const ids = new Set();
    for (let page = 0; page < 1000; page++) {
      if (!takeLock()) return null;
      await waitIdle();
      showProgress('Liste des cartes… page ' + (page + 1));
      let res;
      try { res = await origFetch.call(W, '/api/my-collection?sort=rarity&page=' + page + '&stats=0', { credentials: 'include' }); }
      catch (_) { return null; }
      if (res.status === 401 || res.status === 403) return null; // pas connecté
      if (!res.ok) { await sleep(bgBackoff = Math.min(bgBackoff * 2, 300000)); page--; continue; }
      bgBackoff = BG_DELAY_MS;
      const json = await res.json().catch(() => null);
      if (!json || !Array.isArray(json.collection)) return null; // réponse inattendue (déconnecté ?)
      const list = json.collection;
      learnCollection(json);
      const before = ids.size;
      for (const it of list) if (it && it.card && it.card.id) ids.add(it.card.id);
      if (!list.length || ids.size === before) break; // dernière page atteinte
      await sleep(BG_DELAY_MS);
    }
    const arr = [...ids];
    try { W.localStorage.setItem(LIST_KEY, JSON.stringify({ t: Date.now(), ids: arr })); } catch (_) {}
    return arr;
  }

  async function backgroundRefresh() {
    try {
      if (!takeLock()) return;
      const ids = loadList() || await readWholeCollection();
      if (!ids) return;
      const total = ids.length;
      let todo = ids.filter(id => !cached(id));
      for (let i = 0; i < todo.length; i++) {
        if (!takeLock()) return;
        await waitIdle();
        if (cached(todo[i])) continue; // déjà récupéré entre-temps (carte affichée)
        showProgress('Prix ' + (total - todo.length + i).toLocaleString('fr-FR') + ' / ' + total.toLocaleString('fr-FR'));
        const res = await requestSummary(todo[i]);
        if (res.status === 401 || res.status === 403) return; // déconnecté : on arrête
        const retry = res.status === 0 || res.status === 429 || res.status >= 500;
        if (!res.entry && retry) { // réseau coupé ou trop de requêtes : on ralentit puis on réessaie
          bgBackoff = Math.min(bgBackoff * 2, 300000);
          i--;
        } else { // succès, ou erreur propre à cette carte : on passe à la suivante
          bgBackoff = BG_DELAY_MS;
        }
        await sleep(bgBackoff);
      }
    } finally {
      showProgress(null);
      setTimeout(backgroundRefresh, BG_RECHECK_MS);
    }
  }

  let progressEl = null;
  function showProgress(text) {
    if (!document.body) return;
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.id = 'wm-prix-job';
      document.body.appendChild(progressEl);
    }
    progressEl.style.display = text ? '' : 'none';
    if (text) progressEl.textContent = '⟳ ' + text;
  }

  // ---------- Affichage ----------
  const STYLE = `
    .wm-prix{position:absolute;left:6px;top:calc(45% - 26px);z-index:40;
      padding:2px 7px;border-radius:999px;font:700 12px/18px system-ui,sans-serif;
      background:rgba(10,14,18,.82);color:#34d399;box-shadow:0 1px 4px rgba(0,0,0,.5);
      pointer-events:none;white-space:nowrap}
    .wm-prix.wm-vide{color:#9ca3af}
    .wm-prix.wm-charge{color:#9ca3af;opacity:.7}
    #wm-prix-job{position:fixed;left:50%;transform:translateX(-50%);
      bottom:calc(env(safe-area-inset-bottom, 0px) + 72px);z-index:2147483000;
      padding:2px 9px;border-radius:999px;font:600 11px/17px system-ui,sans-serif;
      background:rgba(10,14,18,.75);color:#6ee7b7;pointer-events:none;opacity:.85}`;
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
    if (BG_ENABLED) setTimeout(backgroundRefresh, BG_START_DELAY_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
