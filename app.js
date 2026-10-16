(() => {
  'use strict';

  const API = 'https://api.klipy.com/api/v1/';
  const PER_PAGE = 36;
  const LOCALE = 'jp';
  const HIST_MAX = 60;
  const LS = { settings: 'gs.settings', favs: 'gs.favs', hist: 'gs.hist', cid: 'gs.cid', tcache: 'gs.tcache' };

  // ---- 保存まわり（プライベートモード等で使えなくても動くように） ----
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても続行 */ } }
  };

  const settings = Object.assign({ key: '', filter: 'medium', translate: true, userDict: '' }, store.get(LS.settings, {}));
  let favs = store.get(LS.favs, []);
  let hist = store.get(LS.hist, []);
  const tcache = store.get(LS.tcache, {});
  let cid = store.get(LS.cid, null);
  if (!cid) {
    cid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    store.set(LS.cid, cid);
  }

  const $ = (s) => document.querySelector(s);
  const el = {
    q: $('#q'), form: $('#searchForm'), chips: $('#chips'), grid: $('#grid'), myGrid: $('#myGrid'),
    mySection: $('#mySection'), resultTitle: $('#resultTitle'), status: $('#status'), more: $('#moreBtn'),
    setup: $('#setupCard'), favGrid: $('#favGrid'), favEmpty: $('#favEmpty'), favFilter: $('#favFilter'),
    histGrid: $('#histGrid'), histEmpty: $('#histEmpty'), toast: $('#toast'),
    detail: $('#detail'), dTitle: $('#detailTitle'), dImg: $('#detailImg'), dCopy: $('#dCopy'),
    dShare: $('#dShare'), dFav: $('#dFav'), dTags: $('#dTags'),
    settings: $('#settings'), sKey: $('#sKey'), sFilter: $('#sFilter'), sTranslate: $('#sTranslate'),
    sDict: $('#sDict'), sTransfer: $('#sTransfer')
  };

  // ---- 日本語の正規化と辞書 ----
  const HAS_JA = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
  const HAS_KANJI = /\p{Script=Han}/u;
  const kataToHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const norm = (s) => kataToHira(String(s).normalize('NFKC').toLowerCase()).replace(/\s+/g, ' ').trim();
  const stripTail = (s) => s.replace(/[!?。、.,~〜ー・]+$/, '');

  let dict = new Map();
  let dictKeys = [];
  function buildDict() {
    dict = new Map();
    for (const [k, v] of Object.entries(window.BUILTIN_DICT || {})) dict.set(norm(k), { alts: v.split('|'), src: '辞書' });
    for (const line of settings.userDict.split('\n')) {
      const parts = line.split(/[=＝]/);
      if (parts.length < 2) continue;
      const k = norm(parts[0]);
      const alts = parts.slice(1).join('=').split(/[,、，|]/).map((x) => x.trim()).filter(Boolean);
      if (k && alts.length) dict.set(k, { alts, src: 'マイ辞書' });
    }
    dictKeys = [...dict.keys()].sort((a, b) => b.length - a.length);
  }

  function lookup(t) {
    const hit = dict.get(t) || dict.get(stripTail(t));
    if (hit) return hit;
    for (const [re, v] of window.BUILTIN_PATTERNS || []) if (re.test(t)) return { alts: v.split('|'), src: '辞書' };
    return null;
  }

  // 文の中に含まれる辞書のことばを拾う（長いことば優先・重複なし）
  function findParts(n) {
    let work = n;
    const hits = [];
    for (const k of dictKeys) {
      if (!(k.length >= 3 || HAS_KANJI.test(k))) continue;
      const i = work.indexOf(k);
      if (i < 0) continue;
      hits.push({ i, ...dict.get(k) });
      work = work.slice(0, i) + '\0'.repeat(k.length) + work.slice(i + k.length);
      if (hits.length >= 4) break;
    }
    return hits.sort((a, b) => a.i - b.i);
  }

  async function translate(q) {
    if (Object.prototype.hasOwnProperty.call(tcache, q)) return tcache[q];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch('https://api.mymemory.translated.net/get?langpair=ja|en&q=' + encodeURIComponent(q), { signal: ctrl.signal });
      clearTimeout(timer);
      const j = await r.json();
      const raw = (j && j.responseData && j.responseData.translatedText) || '';
      if (/mymemory|quota|invalid/i.test(raw)) return '';
      let s = raw.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(a|an|the) /, '');
      if (HAS_JA.test(s) || s.split(' ').length > 6) s = '';
      tcache[q] = s;
      const keys = Object.keys(tcache);
      if (keys.length > 300) delete tcache[keys[0]];
      store.set(LS.tcache, tcache);
      return s;
    } catch {
      return '';
    }
  }

  // 入力 → 検索ワード候補の一覧（辞書の分はすぐ返し、翻訳は pending で後から届く）
  function buildCandidates(raw) {
    const q = raw.trim();
    const n = norm(q);
    const cands = [];
    const seen = new Set();
    const add = (term, label) => {
      const k = term && term.toLowerCase();
      if (!k || seen.has(k)) return;
      seen.add(k);
      cands.push({ term, label });
    };

    if (!HAS_JA.test(n) && !lookup(n)) {
      add(q, '');
      return { cands, pending: null };
    }

    let pending = null;
    const exact = lookup(n);
    if (exact) {
      exact.alts.forEach((a) => add(a, exact.src));
    } else {
      const tokens = n.split(' ').filter(Boolean);
      if (tokens.length > 1) {
        const hits = tokens.map(lookup);
        if (hits.every(Boolean)) add(hits.map((h) => h.alts[0]).join(' '), '辞書');
      }
      const parts = findParts(n);
      if (parts.length >= 2) add(parts.slice(0, 3).map((p) => p.alts[0]).join(' '), parts[0].src);
      parts.slice(0, 3).forEach((p) => add(p.alts[0], p.src));
      if (settings.translate) pending = translate(q);
    }
    add(q, 'そのまま');
    return { cands, pending };
  }

  // ---- KLIPY ----
  async function klipy(path, params) {
    const u = new URL(API + encodeURIComponent(settings.key) + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
    let r;
    try { r = await fetch(u); } catch { throw new Error('network'); }
    if (r.status === 429) throw new Error('rate');
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (r.ok && j && j.result !== false && j.data) return j.data;
    // 例: 404 {"result":false,"errors":{"message":["The provided API key is invalid."]}}
    if (r.status === 401 || r.status === 403 || /api key/i.test(JSON.stringify((j && j.errors) || ''))) throw new Error('auth');
    throw new Error('http');
  }

  function sharePing(slug, q) {
    if (!settings.key || !slug) return;
    fetch(API + encodeURIComponent(settings.key) + '/gifs/share/' + encodeURIComponent(slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: cid, q: q || '' })
    }).catch(() => {});
  }

  function toItem(d) {
    const f = (d && d.file) || {};
    const pick = (sizes, fmts) => {
      for (const s of sizes) for (const fm of fmts) if (f[s] && f[s][fm] && f[s][fm].url) return f[s][fm].url;
      return null;
    };
    const thumb = pick(['sm', 'xs', 'md', 'hd'], ['webp', 'gif']);
    const url = pick(['md', 'hd', 'sm'], ['gif']) || pick(['md', 'hd', 'sm'], ['webp']);
    if (!thumb || !url) return null;
    return { slug: d.slug, title: d.title || '', thumb, url, big: pick(['hd', 'md'], ['webp', 'gif']) || url };
  }

  // ---- 状態 ----
  const state = { view: 'search', raw: '', cands: [], active: 0, term: '', page: 1, hasNext: false, token: 0 };
  let searchToken = 0;

  function setStatus(t) { el.status.textContent = t; }

  function errMsg(e) {
    switch (e.message) {
      case 'auth': return 'APIキーが正しくないようです。⚙ 設定で確認してください。';
      case 'rate': return '検索回数の上限に達しました（テスト用キーは1時間に100回まで）。少し待ってから試してください。';
      case 'network': return '通信できませんでした。ネット接続か、⚙ 設定のAPIキーを確認してください。';
      default: return '読み込みに失敗しました。少し待ってからもう一度試してください。';
    }
  }

  async function loadResults(reset) {
    el.setup.hidden = !!settings.key;
    if (!settings.key) { el.grid.innerHTML = ''; el.more.hidden = true; setStatus(''); el.resultTitle.textContent = ''; return; }
    if (reset) { state.page = 1; el.grid.innerHTML = ''; }
    const my = ++state.token;
    el.more.hidden = true;
    setStatus('読み込み中…');
    try {
      const params = { page: state.page, per_page: PER_PAGE, customer_id: cid, locale: LOCALE, content_filter: settings.filter, format_filter: 'gif,webp' };
      const data = state.term
        ? await klipy('/gifs/search', { ...params, q: state.term })
        : await klipy('/gifs/trending', params);
      if (my !== state.token) return;
      const frag = document.createDocumentFragment();
      (data.data || []).map(toItem).filter(Boolean).forEach((it) => frag.append(tile(it, state.term)));
      el.grid.append(frag);
      state.hasNext = !!data.has_next;
      state.page += 1;
      setStatus(el.grid.children.length ? '' : '見つかりませんでした。上の別の候補を試してみてください。');
      el.more.hidden = !state.hasNext;
    } catch (e) {
      if (my === state.token) setStatus(errMsg(e));
    }
  }

  async function doSearch(raw) {
    state.raw = raw.trim();
    renderMy(state.raw);
    const my = ++searchToken;
    if (!state.raw) {
      state.cands = [];
      state.term = '';
      renderChips();
      el.resultTitle.textContent = settings.key ? 'いま人気のGIF' : '';
      loadResults(true);
      return;
    }
    const { cands, pending } = buildCandidates(state.raw);
    state.cands = cands;
    const ready = !pending || cands[0].label !== 'そのまま';
    if (ready) {
      selectCand(0);
    } else {
      el.chips.innerHTML = '';
      el.grid.innerHTML = '';
      el.more.hidden = true;
      el.resultTitle.textContent = '';
      setStatus('ことばを英語に変換中…');
    }
    if (!pending) return;

    const t = await pending;
    if (my !== searchToken) return;
    if (t && !state.cands.some((c) => c.term.toLowerCase() === t)) {
      const at = state.cands.findIndex((c) => c.label === 'そのまま');
      state.cands.splice(at < 0 ? state.cands.length : at, 0, { term: t, label: '翻訳' });
    }
    if (ready) {
      state.active = Math.max(0, state.cands.findIndex((c) => c.term === state.term));
      renderChips();
    } else {
      selectCand(0);
    }
  }

  function selectCand(i) {
    state.active = i;
    state.term = state.cands[i].term;
    renderChips();
    el.resultTitle.textContent = settings.key ? `「${state.term}」の検索結果` : '';
    loadResults(true);
  }

  function renderChips() {
    el.chips.innerHTML = '';
    const c = state.cands;
    if (c.length < 2) return;
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = '検索ワード：';
    el.chips.append(hint);
    c.forEach((cand, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.setAttribute('aria-pressed', String(i === state.active));
      b.textContent = cand.term;
      if (cand.label) {
        const s = document.createElement('small');
        s.textContent = cand.label;
        b.append(s);
      }
      b.addEventListener('click', () => selectCand(i));
      el.chips.append(b);
    });
  }

  // ---- タイル ----
  function tile(it, q, showTags) {
    const box = document.createElement('div');
    box.className = 'tile';
    box.dataset.slug = it.slug;

    const pickBtn = document.createElement('button');
    pickBtn.className = 'pick';
    pickBtn.type = 'button';
    pickBtn.title = 'クリックでURLをコピー';
    pickBtn.setAttribute('aria-label', `${it.title || 'GIF'} のURLをコピー`);
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = it.title || '';
    img.src = it.thumb;
    pickBtn.append(img);
    pickBtn.addEventListener('click', () => copyGif(it, q));

    const acts = document.createElement('div');
    acts.className = 'acts';
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star';
    paintStar(star, isFav(it.slug));
    star.addEventListener('click', () => toggleFav(it));
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.textContent = '⋯';
    moreBtn.title = '詳細・マイタグ';
    moreBtn.setAttribute('aria-label', '詳細・マイタグ');
    moreBtn.addEventListener('click', () => openDetail(it, q));
    acts.append(star, moreBtn);
    box.append(pickBtn, acts);

    const fav = showTags && favs.find((f) => f.slug === it.slug);
    if (fav && fav.tags && fav.tags.length) {
      const tl = document.createElement('div');
      tl.className = 'tagline';
      tl.textContent = fav.tags.map((t) => '#' + t).join(' ');
      box.append(tl);
    }
    return box;
  }

  function paintStar(btn, on) {
    btn.textContent = on ? '★' : '☆';
    btn.classList.toggle('on', on);
    btn.title = on ? 'お気に入りから外す' : 'お気に入りに追加';
    btn.setAttribute('aria-label', btn.title);
  }

  function syncStars(slug) {
    const on = isFav(slug);
    document.querySelectorAll('.tile').forEach((t) => {
      if (t.dataset.slug === slug) paintStar(t.querySelector('.star'), on);
    });
  }

  // ---- コピー・共有 ----
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.append(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }

  async function copyGif(it, q) {
    const ok = await copyText(it.url);
    toast(ok ? 'コピーしました！Discordに貼り付けてください' : 'コピーできませんでした。⋯ から共有を試してください');
    if (ok) { addHist(it); sharePing(it.slug, q); }
  }

  let toastTimer;
  function toast(t) {
    el.toast.textContent = t;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
  }

  // ---- お気に入り・履歴・マイタグ ----
  const isFav = (slug) => favs.some((f) => f.slug === slug);
  const saveFavs = () => store.set(LS.favs, favs);

  function toggleFav(it) {
    const i = favs.findIndex((f) => f.slug === it.slug);
    if (i >= 0) {
      const f = favs[i];
      if (f.tags && f.tags.length && !confirm('マイタグも一緒に消えます。お気に入りから外しますか？')) return;
      favs.splice(i, 1);
      toast('お気に入りから外しました');
    } else {
      favs.unshift({ slug: it.slug, title: it.title, thumb: it.thumb, url: it.url, big: it.big, tags: [], added: Date.now() });
      toast('お気に入りに追加しました');
    }
    saveFavs();
    syncStars(it.slug);
    if (state.view === 'fav') renderFavs();
    renderMy(state.raw);
  }

  function addHist(it) {
    hist = [{ slug: it.slug, title: it.title, thumb: it.thumb, url: it.url, big: it.big }, ...hist.filter((h) => h.slug !== it.slug)].slice(0, HIST_MAX);
    store.set(LS.hist, hist);
    if (state.view === 'hist') renderHist();
  }

  function matchesFav(f, n) {
    if (!n) return true;
    if ((f.tags || []).some((t) => { const nt = norm(t); return nt && (nt.includes(n) || n.includes(nt)); })) return true;
    return norm(f.title || '').includes(n);
  }

  function renderMy(raw) {
    const n = norm(raw || '');
    el.myGrid.innerHTML = '';
    if (!n) { el.mySection.hidden = true; return; }
    const hits = favs.filter((f) => (f.tags || []).length && matchesFav(f, n)).slice(0, 24);
    hits.forEach((f) => el.myGrid.append(tile(f, '', true)));
    el.mySection.hidden = hits.length === 0;
  }

  function renderFavs() {
    const n = norm(el.favFilter.value);
    el.favGrid.innerHTML = '';
    const list = favs.filter((f) => matchesFav(f, n));
    list.forEach((f) => el.favGrid.append(tile(f, '', true)));
    el.favEmpty.textContent = favs.length === 0 ? '★を押すとここに保存されます。' : list.length === 0 ? '一致するお気に入りはありません。' : '';
  }

  function renderHist() {
    el.histGrid.innerHTML = '';
    hist.forEach((h) => el.histGrid.append(tile(h, '', true)));
    el.histEmpty.textContent = hist.length ? '' : 'コピーしたGIFがここに並びます。';
  }

  // ---- 詳細シート ----
  let current = null;
  function openDetail(it, q) {
    current = { it, q };
    el.dTitle.textContent = it.title || 'GIF';
    el.dImg.src = it.big || it.url;
    el.dImg.alt = it.title || '';
    const fav = favs.find((f) => f.slug === it.slug);
    el.dTags.value = fav && fav.tags ? fav.tags.join(' ') : '';
    el.dFav.textContent = fav ? '★ お気に入り済み' : '☆ お気に入り';
    el.dShare.hidden = !navigator.share;
    el.detail.showModal();
  }

  function saveTags() {
    if (!current) return;
    const { it } = current;
    const tags = el.dTags.value.split(/[\s,、，]+/).map((t) => t.trim()).filter(Boolean);
    let fav = favs.find((f) => f.slug === it.slug);
    if (!fav && !tags.length) return;
    if (!fav) {
      fav = { slug: it.slug, title: it.title, thumb: it.thumb, url: it.url, big: it.big, tags: [], added: Date.now() };
      favs.unshift(fav);
    }
    if (fav.tags.join(' ') === tags.join(' ')) return;
    fav.tags = tags;
    saveFavs();
    syncStars(it.slug);
    renderMy(state.raw);
    if (state.view === 'fav') renderFavs();
    if (tags.length) toast('マイタグを保存しました');
  }

  el.dTags.addEventListener('change', saveTags);
  el.detail.addEventListener('close', () => { saveTags(); current = null; el.dImg.removeAttribute('src'); });
  el.dCopy.addEventListener('click', () => current && copyGif(current.it, current.q));
  el.dShare.addEventListener('click', async () => {
    if (!current) return;
    try {
      await navigator.share({ url: current.it.url });
      addHist(current.it);
      sharePing(current.it.slug, current.q);
    } catch { /* 共有をキャンセル */ }
  });
  el.dFav.addEventListener('click', () => {
    if (!current) return;
    saveTags();
    toggleFav(current.it);
    const fav = favs.find((f) => f.slug === current.it.slug);
    el.dFav.textContent = fav ? '★ お気に入り済み' : '☆ お気に入り';
    if (!fav) el.dTags.value = '';
  });

  // ---- 画面切り替え ----
  function showView(v) {
    state.view = v;
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
    $('#view-search').hidden = v !== 'search';
    $('#view-fav').hidden = v !== 'fav';
    $('#view-hist').hidden = v !== 'hist';
    if (v === 'fav') renderFavs();
    if (v === 'hist') renderHist();
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  // ---- 設定 ----
  function openSettings() {
    el.sKey.value = settings.key;
    el.sFilter.value = settings.filter;
    el.sTranslate.checked = settings.translate;
    el.sDict.value = settings.userDict;
    el.sTransfer.value = '';
    el.settings.showModal();
  }
  $('#settingsBtn').addEventListener('click', openSettings);
  document.querySelectorAll('[data-open-settings]').forEach((b) => b.addEventListener('click', openSettings));

  $('#sSave').addEventListener('click', () => {
    const hadKey = !!settings.key;
    settings.key = el.sKey.value.trim();
    settings.filter = el.sFilter.value;
    settings.translate = el.sTranslate.checked;
    settings.userDict = el.sDict.value;
    store.set(LS.settings, settings);
    buildDict();
    el.settings.close();
    toast('保存しました');
    if (settings.key && (!hadKey || !el.grid.children.length)) doSearch(el.q.value);
    else el.setup.hidden = !!settings.key;
  });

  $('#sExport').addEventListener('click', async () => {
    const data = JSON.stringify({ app: 'gif-sagashi', v: 1, favs, userDict: el.sDict.value });
    el.sTransfer.value = data;
    toast((await copyText(data)) ? '書き出してコピーしました。もう一方の端末に貼り付けてください' : '書き出しました。欄の文字をコピーしてください');
  });

  $('#sImport').addEventListener('click', () => {
    let data;
    try { data = JSON.parse(el.sTransfer.value); } catch { data = null; }
    if (!data || data.app !== 'gif-sagashi') { toast('読み込めませんでした。書き出した文字をそのまま貼り付けてください'); return; }
    let added = 0;
    for (const f of data.favs || []) {
      if (!f || !f.slug || !f.url) continue;
      const mine = favs.find((x) => x.slug === f.slug);
      if (mine) mine.tags = [...new Set([...(mine.tags || []), ...(f.tags || [])])];
      else { favs.push({ ...f, tags: f.tags || [] }); added++; }
    }
    saveFavs();
    if (data.userDict) {
      const have = new Set(el.sDict.value.split('\n').map((l) => l.trim()));
      const extra = data.userDict.split('\n').filter((l) => l.trim() && !have.has(l.trim()));
      if (extra.length) el.sDict.value = (el.sDict.value.trim() ? el.sDict.value.trim() + '\n' : '') + extra.join('\n');
    }
    toast(`お気に入りを${added}件追加しました。辞書は「保存」で反映されます`);
    renderMy(state.raw);
    if (state.view === 'fav') renderFavs();
  });

  $('#clearHist').addEventListener('click', () => {
    if (!hist.length || !confirm('履歴をすべて消しますか？')) return;
    hist = [];
    store.set(LS.hist, hist);
    renderHist();
  });

  el.favFilter.addEventListener('input', renderFavs);

  // ---- 検索フォーム ----
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    showView('search');
    el.q.blur();
    doSearch(el.q.value);
  });
  el.more.addEventListener('click', () => loadResults(false));

  // 「/」で検索欄へ（PC向け）
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      el.q.focus();
      el.q.select();
    }
  });

  // ---- 起動 ----
  buildDict();
  const initial = new URLSearchParams(location.search).get('q') || '';
  el.q.value = initial;
  doSearch(initial);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // テストや確認用に候補づくりだけ外から呼べるようにしておく
  window.gifSagashi = { buildCandidates, norm };
})();
