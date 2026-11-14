// ==UserScript==
// @name         WikiMasters – Prix moyen sur les cartes
// @namespace    https://github.com/ch4mo/mod_wiki
// @version      1.3.0
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
  const DELAY_MS = 250;                    // pause minimale entre deux requêtes (cartes à l'écran)
  const MAX_DELAY_MS = 3000;               // pause maximale quand le site freine
  const PAUSE_MIN_MS = 5000;               // pause après un refus « trop de requêtes »…
  const PAUSE_MAX_MS = 120000;             // …doublée à chaque refus, jusqu'à 2 min
  const MAX_RETRIES = 8;                   // essais max pour une carte affichée

  // Actualisation de fond : parcourt toute la collection tranquillement.
  const BG_ENABLED = true;
  const BG_DELAY_MS = 2000;                        // 1 requête toutes les 2 s
  const BG_FULL_LIST_TTL_MS = 7 * 24 * 60 * 60 * 1000; // relecture complète de la liste 1 fois par semaine
  const BG_RECHECK_MS = 10 * 60 * 1000;            // vérifie les nouvelles cartes toutes les 10 min
  const BG_START_DELAY_MS = 5000;                  // laisse le site se charger d'abord
  const LIST_KEY = 'wmPrixMoyenListe.v2';
  const LOCK_KEY = 'wmPrixMoyenVerrou.v1';
  const RARITIES = ['L', 'UR', 'SR', 'R', 'PC', 'C'];

  const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  // ---------- Liste de toutes les cartes (différentes) de la collection ----------
  // { full: date de la dernière relecture complète, total: nombre de cartes annoncé par le site
  //   lors de la dernière synchro, ids: [...] } — les plus récentes en premier.
  let cardList = null;
  try {
    const l = JSON.parse(W.localStorage.getItem(LIST_KEY) || 'null');
    if (l && Array.isArray(l.ids)) cardList = { full: l.full || 0, total: l.total, ids: l.ids };
  } catch (_) { /* ignore */ }
  let cardSet = new Set(cardList ? cardList.ids : []);
  function saveList() {
    try { W.localStorage.setItem(LIST_KEY, JSON.stringify(cardList)); } catch (_) { /* ignore */ }
  }
  // Ajoute en tête de liste les cartes inconnues (ex. : nouvelles cartes vues par le site).
  function addToList(ids) {
    if (!cardList) return 0;
    const fresh = ids.filter(id => !cardSet.has(id));
    if (!fresh.length) return 0;
    for (const id of fresh) cardSet.add(id);
    cardList.ids = fresh.concat(cardList.ids);
    saveList();
    return fresh.length;
  }

  // ---------- Correspondance "titre|rareté" -> id de carte ----------
  // Rempli en lisant les réponses de /api/my-collection que le site charge lui-même.
  const index = new Map();
  function learnCollection(json) {
    const list = json && Array.isArray(json.collection) ? json.collection : null;
    if (!list) return [];
    const ids = [];
    for (const item of list) {
      const c = item && item.card;
      if (!c || !c.id) continue;
      ids.push(c.id);
      if (!c.wikipedia_title) continue;
      const key = c.wikipedia_title + '|' + c.rarity;
      const arr = index.get(key) || [];
      if (!arr.some(x => x.id === c.id)) arr.push({ id: c.id, img: c.image_url || '' });
      index.set(key, arr);
    }
    scan();
    return ids;
  }

  const origFetch = W.fetch;
  W.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\/api\/my-collection(\?|$)/.test(url)) {
        p.then(r => r.clone().json()).then(json => {
          if (addToList(learnCollection(json))) wakeBackground();
        }).catch(() => {});
      } else if (/\/api\/my-collection\/stats\?/.test(url) && !/[?&](rarity|q|tag_id|untagged|wishlisted_by)=/.test(url)) {
        // Le site affiche ses statistiques : si le nombre de cartes a changé, on resynchronise.
        p.then(r => r.clone().json()).then(json => {
          if (json && typeof json.totalUnique === 'number' && (!cardList || json.totalUnique !== cardList.total)) wakeBackground();
        }).catch(() => {});
      }
    } catch (_) { /* ne jamais casser le site */ }
    return p;
  };

  // ---------- Limitation du débit (commune aux cartes affichées et à la tâche de fond) ----------
  // Quand le site répond « trop de requêtes » (429), tout le monde fait une pause qui double à
  // chaque nouveau refus ; le rythme des cartes affichées ralentit aussi, puis réaccélère.
  let pauseUntil = 0;
  let pauseLen = PAUSE_MIN_MS;
  let visibleDelay = DELAY_MS;

  const isRetryable = status => status === 0 || status === 429 || status >= 500;

  function noteResult(status) {
    if (isRetryable(status)) {
      pauseUntil = Date.now() + pauseLen;
      pauseLen = Math.min(pauseLen * 2, PAUSE_MAX_MS);
      visibleDelay = Math.min(visibleDelay * 2, MAX_DELAY_MS);
    } else {
      pauseLen = PAUSE_MIN_MS;
      visibleDelay = Math.max(DELAY_MS, Math.round(visibleDelay * 0.9));
    }
  }

  async function waitPause() {
    while (Date.now() < pauseUntil) await sleep(pauseUntil - Date.now());
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
      .catch(() => ({ entry: null, status: 0 }))
      .then(res => { noteResult(res.status); return res; });
  }

  // ---------- File des cartes affichées ----------
  const queue = [];
  const pending = new Map(); // cardId -> Promise
  let active = 0;
  let pumpTimer = null;

  function fetchAverage(cardId) {
    if (pending.has(cardId)) return pending.get(cardId);
    const pr = new Promise(resolve => queue.push({ cardId, resolve, tries: 0 }));
    pending.set(cardId, pr);
    pump();
    return pr;
  }

  function pump() {
    if (Date.now() < pauseUntil) { // le site freine : on attend la fin de la pause
      if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, pauseUntil - Date.now());
      return;
    }
    const parallel = visibleDelay > DELAY_MS * 2 ? 1 : MAX_PARALLEL; // une seule à la fois si le site freine
    while (active < parallel && queue.length && Date.now() >= pauseUntil) {
      // Dernière carte demandée d'abord : en défilant vite, celles à l'écran passent devant.
      const job = queue.pop();
      active++;
      requestSummary(job.cardId).then(res => {
        if (!res.entry && isRetryable(res.status) && ++job.tries < MAX_RETRIES) {
          queue.unshift(job); // on la redemandera après la pause (prix toujours « … »)
        } else {
          pending.delete(job.cardId);
          job.resolve(res.entry);
        }
        setTimeout(() => { active--; pump(); }, visibleDelay);
      });
    }
  }

  // ---------- Actualisation de fond ----------
  // Tourne tant que le site est ouvert (pas besoin de faire défiler). La progression est
  // conservée : si l'application est fermée, elle reprend là où elle en était.
  const tabId = Math.random().toString(36).slice(2);
  let bgRunning = false;
  let bgTimer = null;
  let bgResync = false;

  function takeLock() {
    // Évite deux actualisations en parallèle (plusieurs onglets).
    try {
      const l = JSON.parse(W.localStorage.getItem(LOCK_KEY) || 'null');
      if (l && l.id !== tabId && Date.now() - l.t < 30000) return false;
      W.localStorage.setItem(LOCK_KEY, JSON.stringify({ id: tabId, t: Date.now() }));
      return true;
    } catch (_) { return true; }
  }

  // Relance la tâche de fond rapidement (nouvelles cartes détectées).
  function wakeBackground() {
    if (!BG_ENABLED) return;
    if (bgRunning) { bgResync = true; return; }
    clearTimeout(bgTimer);
    bgTimer = setTimeout(backgroundRefresh, 1000);
  }

  // Attend que les cartes affichées soient servies en priorité et que le site ne freine plus.
  async function waitIdle() {
    while (queue.length || active || Date.now() < pauseUntil) {
      await waitPause();
      if (queue.length || active) await sleep(500);
    }
  }

  // Requête de lecture vers le site, avec réessai si le site freine. null = abandon (déconnecté…).
  async function getJson(url) {
    for (let tries = 0; tries < 10; tries++) {
      if (!takeLock()) return null;
      await waitIdle();
      let res;
      try { res = await origFetch.call(W, url, { credentials: 'include' }); } catch (_) { res = { status: 0, ok: false }; }
      noteResult(res.status);
      if (res.status === 401 || res.status === 403) return null; // pas connecté
      if (!res.ok) { if (isRetryable(res.status)) continue; return null; }
      return res.json().catch(() => null);
    }
    return null;
  }

  async function fetchStats() {
    const json = await getJson('/api/my-collection/stats?sort=added');
    return json && typeof json.totalUnique === 'number' ? json.totalUnique : null;
  }

  // Lit une page de la collection, triée par date d'ajout. Renvoie la liste des ids, ou null.
  async function readPage(page) {
    const json = await getJson('/api/my-collection?sort=added&page=' + page + '&stats=0');
    if (!json || !Array.isArray(json.collection)) return null; // réponse inattendue (déconnecté ?)
    return learnCollection(json);
  }

  async function readWholeCollection() {
    const total = await fetchStats();
    const ids = [];
    const seen = new Set();
    for (let page = 0; page < 1000; page++) {
      showProgress('Liste des cartes… page ' + (page + 1));
      const got = await readPage(page);
      if (!got) return false;
      const before = seen.size;
      for (const id of got) if (!seen.has(id)) { seen.add(id); ids.push(id); }
      if (!got.length || seen.size === before) break; // dernière page atteinte
      await sleep(BG_DELAY_MS);
    }
    cardList = { full: Date.now(), total, ids };
    cardSet = seen;
    saveList();
    return true;
  }

  // Ne relit que les premières pages (cartes les plus récentes) jusqu'à ne plus rien trouver de neuf.
  // Renvoie le nombre de cartes ajoutées, ou null en cas d'échec.
  async function readNewCards() {
    let added = 0;
    for (let page = 0; page < 1000; page++) {
      showProgress('Nouvelles cartes… page ' + (page + 1));
      const got = await readPage(page);
      if (!got) return null;
      const n = got.length ? addToList(got) : 0;
      added += n;
      if (!n) break;
      await sleep(BG_DELAY_MS);
    }
    return added;
  }

  // Met la liste à jour : relecture complète 1 fois par semaine, sinon seulement les nouveautés.
  async function syncList() {
    if (!cardList || Date.now() - cardList.full > BG_FULL_LIST_TTL_MS) return readWholeCollection();
    const total = await fetchStats();
    if (total == null) return false;
    if (total === cardList.total) return true; // rien de changé
    // Le nombre a changé : on lit les cartes les plus récentes. (Les cartes vendues ou
    // défaussées restent dans la liste jusqu'à la relecture complète hebdomadaire : sans gravité.)
    if (total > (cardList.total || 0)) {
      const added = await readNewCards();
      if (added == null) return false;
      if (!added) return readWholeCollection(); // rien trouvé en tête de liste : relecture complète
    }
    cardList.total = total;
    saveList();
    return true;
  }

  async function backgroundRefresh() {
    if (bgRunning) return;
    bgRunning = true;
    clearTimeout(bgTimer);
    try {
      do {
        bgResync = false;
        if (!takeLock()) return;
        if (!await syncList()) return;
        const failed = new Set(); // cartes en erreur définitive pour ce passage
        for (;;) {
          if (bgResync) break; // nouvelles cartes détectées : on resynchronise d'abord
          if (!takeLock()) return;
          await waitIdle();
          const ids = cardList.ids;
          const next = ids.find(id => !cached(id) && !failed.has(id));
          if (!next) break;
          const done = ids.reduce((n, id) => n + (cached(id) ? 1 : 0), 0);
          showProgress('Prix ' + done.toLocaleString('fr-FR') + ' / ' + ids.length.toLocaleString('fr-FR'));
          const res = await requestSummary(next);
          if (res.status === 401 || res.status === 403) return; // déconnecté : on arrête
          if (!res.entry && !isRetryable(res.status)) failed.add(next); // erreur propre à cette carte
          await sleep(BG_DELAY_MS); // (en cas de « trop de requêtes », waitIdle attend la pause)
        }
      } while (bgResync);
    } finally {
      bgRunning = false;
      showProgress(null);
      clearTimeout(bgTimer);
      bgTimer = setTimeout(backgroundRefresh, BG_RECHECK_MS);
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
      if (cardEl.dataset.wmKey !== info.key) return;
      render(cardEl, info.rarity, entry);
      if (!entry) { // échec : on retentera quand la carte sera de nouveau visible
        setTimeout(() => {
          if (cardEl.dataset.wmKey === info.key) { cardEl.dataset.wmKey = ''; scheduleScan(); }
        }, 30000);
      }
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
    if (BG_ENABLED) bgTimer = setTimeout(backgroundRefresh, BG_START_DELAY_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
