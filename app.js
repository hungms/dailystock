(() => {
  'use strict';

  const TABLE_DAYS = 14;
  const LS_KEY = 'dailystock.settings';
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  const UNDO_MS = 8000;
  const LIVE_MS = 60000;      // 交易時段內每分鐘更新即時報價
  const QUOTE_BATCH = 60;     // 每次向騰訊查詢的股票數目

  const $ = (sel) => document.querySelector(sel);
  const state = {
    stocks: [], log: [], prices: { stocks: {} }, names: {},
    live: { ok: null, time: null }, liveBusy: false,
    selected: null, chartDays: 14, chart: null, polling: null,
    mgTab: 'list', mgSel: new Set(), logFilter: 'all',
  };

  // ---------- 設定（只存於此瀏覽器） ----------
  function guessRepo() {
    const host = location.hostname;
    if (!host.endsWith('.github.io')) return '';
    const owner = host.split('.')[0];
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return seg ? `${owner}/${seg}` : `${owner}/${host}`;
  }
  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { /* 無法存取 */ }
    return { repo: s.repo || guessRepo(), branch: s.branch || 'main', token: s.token || '' };
  }
  function saveSettings(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* 無法存取 */ }
  }
  let settings = loadSettings();
  const canEdit = () => Boolean(settings.token && settings.repo);

  // ---------- 數字及日期格式（阿拉伯數字） ----------
  const fmtCache = {};
  function fmt(v, digits) {
    if (v == null || Number.isNaN(v)) return '—';
    const d = digits ?? (Math.abs(v) < 10 ? 3 : 2);
    fmtCache[d] ||= new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    return fmtCache[d].format(v);
  }
  const signed = (v, digits) => (v > 0 ? '+' : '') + fmt(v, digits);
  function parseIso(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return { y, m, d, wd: WEEKDAYS[new Date(y, m - 1, d).getDay()] };
  }
  const fmtDateShort = (iso) => { const p = parseIso(iso); return `${p.m}/${p.d}（${p.wd}）`; };
  const fmtDateLong = (iso) => { const p = parseIso(iso); return `${p.y}年${p.m}月${p.d}日（${p.wd}）`; };
  const fmtAxisDate = (iso) => { const p = parseIso(iso); return `${p.m}/${p.d}`; };
  function hkParts(isoTs) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(isoTs)).reduce((a, p) => (a[p.type] = p.value, a), {});
  }
  function fmtDateTime(isoTs) {
    const p = hkParts(isoTs);
    return `${Number(p.month)}月${Number(p.day)}日 ${p.hour}:${p.minute}`;
  }
  function fmtLogTime(isoTs) {
    const p = hkParts(isoTs);
    return `${p.year}/${Number(p.month)}/${Number(p.day)} ${p.hour}:${p.minute}`;
  }
  const hkDate = (isoTs) => { const p = hkParts(isoTs); return `${p.year}-${p.month}-${p.day}`; };

  function normalizeSymbol(raw) {
    let s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
    s = s.replace(/\.HK$/, '');
    if (!/^\d{1,5}$/.test(s)) return null;
    s = s.replace(/^0+/, '') || '0';
    return s.padStart(4, '0') + '.HK';
  }
  const shortCode = (sym) => sym.replace('.HK', '');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- GitHub API ----------
  async function gh(path, opts = {}) {
    const res = await fetch(`https://api.github.com/repos/${settings.repo}${path}`, {
      ...opts,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${settings.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg += ' ' + (await res.json()).message; } catch (e) { /* 忽略 */ }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  async function fetchStatic(path) {
    const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
  }

  function b64utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }
  function utf8b64(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  async function readRemote() {
    const meta = await (await gh(`/contents/stocks.json?ref=${encodeURIComponent(settings.branch)}`)).json();
    return { sha: meta.sha, doc: JSON.parse(utf8b64(meta.content)) };
  }

  // 有權杖時直接從儲存庫讀取最新的 stocks.json（避免網站發佈延遲）
  async function loadStocksJson() {
    if (canEdit()) {
      try { return (await readRemote()).doc; } catch (e) { console.warn('GitHub API 讀取失敗，改用網站檔案', e); }
    }
    return fetchStatic('stocks.json');
  }

  // 所有寫入依次排隊，避免連續操作互相覆蓋
  let writeQueue = Promise.resolve();
  function enqueue(fn) {
    const p = writeQueue.then(fn);
    writeQueue = p.catch(() => {});
    return p;
  }

  // 讀取儲存庫最新內容 → mutate(doc) 修改列表並回傳紀錄 → 一次提交（列表及紀錄同步）
  function commitWatchlist(mutate, message) {
    return enqueue(async () => {
      for (let attempt = 0; ; attempt++) {
        const { sha, doc } = await readRemote();
        const next = { stocks: [...(doc.stocks || [])], log: [...(doc.log || [])] };
        const result = mutate(next);
        if (!result.changed) {
          applyDoc(next);
          return result;
        }
        try {
          await gh('/contents/stocks.json', {
            method: 'PUT',
            body: JSON.stringify({
              message,
              content: b64utf8(JSON.stringify(next, null, 2) + '\n'),
              sha,
              branch: settings.branch,
            }),
          });
          applyDoc(next);
          return result;
        } catch (e) {
          if ((e.status === 409 || e.status === 422) && attempt < 2) continue; // 版本衝突，重新讀取再試
          throw e;
        }
      }
    });
  }

  function applyDoc(doc) {
    state.stocks = doc.stocks || [];
    state.log = doc.log || [];
    const live = new Set(state.stocks.map((s) => s.symbol));
    state.mgSel.forEach((s) => { if (!live.has(s)) state.mgSel.delete(s); });
    renderAll();
  }

  // ---------- 提示 ----------
  function notice(text) {
    const el = $('#notice');
    el.textContent = text || '';
    el.hidden = !text;
  }

  let toastTimer = null;
  function toast(text, undoFn) {
    const el = $('#toast');
    // 對話框開啟時，提示需放入對話框內才可按
    const host = document.querySelector('dialog[open]') || document.body;
    if (el.parentElement !== host) host.appendChild(el);
    $('#toast-text').textContent = text;
    const undo = $('#toast-undo');
    undo.hidden = !undoFn;
    undo.onclick = undoFn ? () => { hideToast(); undoFn(); } : null;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, undoFn ? UNDO_MS : 4000);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    $('#toast').hidden = true;
  }

  // ---------- 價格資料 ----------
  const stockData = (sym) => state.prices.stocks?.[sym] || null;
  const code5 = (sym) => shortCode(sym).padStart(5, '0');
  const hkName = (sym) => state.names[code5(sym)] || '';
  const displayName = (s) => s.name || hkName(s.symbol) || stockData(s.symbol)?.name || s.symbol;
  function priceOf(sym) {
    const d = stockData(sym);
    return d?.current ?? d?.history?.[d.history.length - 1]?.c ?? null;
  }
  // 紀錄的參考價：記下的價格；如加入時尚未有資料，用加入當日或之後第一個收市價
  function refPrice(entry) {
    if (entry.price != null) return entry.price;
    const day = hkDate(entry.t);
    const hit = (stockData(entry.symbol)?.history || []).find((r) => r.d >= day);
    return hit ? hit.c : null;
  }
  function addedAt(sym) {
    for (let i = state.log.length - 1; i >= 0; i--) {
      if (state.log[i].symbol === sym && state.log[i].a === 'add') return state.log[i];
    }
    return null;
  }

  // ---------- 即時報價（騰訊） ----------
  const tcCode = (sym) => 'hk' + code5(sym);

  // 港股交易時段：週一至五 09:00–12:00、13:00–16:10（含收市競價）
  function marketOpen(date = new Date()) {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Hong_Kong', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
    if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
    const m = Number(p.hour) * 60 + Number(p.minute);
    return (m >= 540 && m < 720) || (m >= 780 && m <= 970);
  }

  // 把一個報價放入該股票的歷史：同日則取代，較新則加在最後
  function mergeQuote(sym, d, h, l, c) {
    const all = (state.prices.stocks ||= {});
    const st = (all[sym] ||= { name: '', current: null, history: [] });
    const hist = st.history;
    const lastRow = hist[hist.length - 1];
    const row = { d, h, l, c };
    if (lastRow && lastRow.d === d) hist[hist.length - 1] = row;
    else if (!lastRow || lastRow.d < d) hist.push(row);
    else return;
    st.current = c;
  }

  async function fetchLiveQuotes() {
    const syms = state.stocks.map((s) => s.symbol);
    if (!syms.length) return;
    const batches = [];
    for (let i = 0; i < syms.length; i += QUOTE_BATCH) batches.push(syms.slice(i, i + QUOTE_BATCH));
    try {
      const texts = await Promise.all(batches.map(async (b) => {
        const res = await fetch(`https://qt.gtimg.cn/q=${b.map(tcCode).join(',')}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(res.status);
        return new TextDecoder('gbk').decode(await res.arrayBuffer());
      }));
      let newest = null;
      let n = 0;
      texts.join('\n').split(';').forEach((line) => {
        const m = line.match(/v_hk(\d+)="([^"]*)"/);
        if (!m) return;
        const f = m[2].split('~');
        if (f.length < 35) return;
        const sym = normalizeSymbol(m[1]);
        const last = Number(f[3]);
        const h = Number(f[33]);
        const l = Number(f[34]);
        const t = f[30]; // 例如 2026/11/23 16:08:28
        if (!sym || !(last > 0) || !/^\d{4}\/\d{2}\/\d{2}/.test(t)) return;
        mergeQuote(sym, t.slice(0, 10).replace(/\//g, '-'), h > 0 ? h : last, l > 0 ? l : last, last);
        if (!newest || t > newest) newest = t;
        n += 1;
      });
      state.live = { ok: n > 0, time: newest || state.live.time };
    } catch (e) {
      console.warn('即時報價失敗', e);
      state.live = { ok: false, time: state.live.time };
    }
  }

  // 為未有資料的股票即時下載最近 100 日歷史（新加入的股票不用等網站更新）
  async function fetchHistory(symbols) {
    const all = (state.prices.stocks ||= {});
    await Promise.all(symbols.map(async (sym) => {
      try {
        const tc = tcCode(sym);
        const res = await fetch(`https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${tc},day,,,100`, { cache: 'no-store' });
        const rows = (await res.json())?.data?.[tc]?.day || [];
        const history = rows
          .map((r) => ({ d: r[0], h: Number(r[3]), l: Number(r[4]), c: Number(r[2]) }))
          .filter((r) => r.h > 0 && r.l > 0 && r.c > 0);
        if (history.length && !all[sym]?.history?.length) {
          all[sym] = { name: hkName(sym), current: history[history.length - 1].c, history };
        }
      } catch (e) {
        console.warn('歷史資料下載失敗', sym, e);
      }
    }));
  }
  const missingData = (symbols) => symbols.filter((sym) => !stockData(sym)?.history?.length);

  async function refreshLive() {
    if (state.liveBusy) return;
    state.liveBusy = true;
    try {
      const missing = missingData(state.stocks.map((s) => s.symbol));
      if (missing.length) await fetchHistory(missing);
      await fetchLiveQuotes();
    } finally {
      state.liveBusy = false;
    }
    renderUpdated();
    renderTable();
    renderManage();
    if ($('#dlg-chart').open) renderChart();
  }

  // ---------- 表格 ----------
  // 與前一交易日同一數值比較：紅升、藍跌
  const dirClass = (cur, prev) => (prev == null || cur == null ? '' : cur > prev ? 'up' : cur < prev ? 'down' : '');

  function syncHeaderHeight() {
    const r1 = document.querySelector('#grid thead tr.r1');
    if (r1) document.documentElement.style.setProperty('--h1', `${r1.getBoundingClientRect().height}px`);
  }

  function renderTable() {
    const thead = $('#grid thead');
    const tbody = $('#grid tbody');
    const stocks = state.stocks;

    if (!stocks.length) {
      thead.innerHTML = '';
      tbody.innerHTML = '<tr><td class="blank">尚未加入任何股票，請按「＋ 新增」。</td></tr>';
      return;
    }

    // 所有股票的交易日合併，取最近 14 日，新到舊
    const dateSet = new Set();
    stocks.forEach((s) => (stockData(s.symbol)?.history || []).forEach((r) => dateSet.add(r.d)));
    const dates = [...dateSet].sort().reverse().slice(0, TABLE_DAYS);

    const rm = (sym) => (canEdit() ? `<button class="remove" data-remove="${sym}" aria-label="移除">✕</button>` : '');
    let h1 = '<tr class="r1"><th class="date-col" rowspan="2">日期</th>';
    let h2 = '<tr class="r2">';
    stocks.forEach((s) => {
      h1 += `<th colspan="4" class="g" data-sym="${s.symbol}"><span class="stock-head">
        <button class="stock-name" data-chart="${s.symbol}">${escapeHtml(displayName(s))}</button>
        <span class="code">${shortCode(s.symbol)}</span>${rm(s.symbol)}</span></th>`;
      h2 += '<th class="g">最高</th><th>最低</th><th>波幅</th><th>現價</th>';
    });
    thead.innerHTML = h1 + '</tr>' + h2 + '</tr>';

    const lookups = stocks.map((s) => {
      const d = stockData(s.symbol);
      const hist = d?.history || [];
      const map = new Map();
      hist.forEach((r, i) => map.set(r.d, { r, prev: hist[i - 1] || null, last: i === hist.length - 1 }));
      return { map, current: d?.current };
    });

    if (!dates.length) {
      tbody.innerHTML = `<tr><td class="date-col">—</td>${stocks.map(() =>
        '<td class="g empty" colspan="4">等待資料更新…</td>').join('')}</tr>`;
      syncHeaderHeight();
      return;
    }

    tbody.innerHTML = dates.map((date, idx) => {
      let row = `<tr${idx === 0 ? ' class="today"' : ''}><td class="date-col">${fmtDateShort(date)}</td>`;
      lookups.forEach(({ map, current }, i) => {
        const alt = i % 2 ? 'alt' : '';
        const hit = map.get(date);
        if (!hit) {
          row += `<td class="g empty ${alt}" colspan="4">${map.size ? '—' : '等待資料更新…'}</td>`;
          return;
        }
        const { r, prev, last } = hit;
        const dg = r.l < 10 ? 3 : 2;
        const price = last && current != null ? current : r.c;
        const range = r.h - r.l;
        const pct = r.l ? (range / r.l) * 100 : null;
        const pRange = prev ? prev.h - prev.l : null;
        const chgPct = prev?.c ? ((price - prev.c) / prev.c) * 100 : null;

        row += `<td class="g ${alt} ${dirClass(r.h, prev?.h)}">${fmt(r.h, dg)}</td>`
          + `<td class="${alt} ${dirClass(r.l, prev?.l)}">${fmt(r.l, dg)}</td>`
          + `<td class="${alt} ${dirClass(range, pRange)}">${fmt(range, dg)}<span class="sub">${fmt(pct, 2)}%</span></td>`
          + `<td class="${alt} ${dirClass(price, prev?.c)}">${fmt(price, dg)}`
          + `<span class="sub">${chgPct == null ? '&nbsp;' : signed(chgPct, 2) + '%'}</span></td>`;
      });
      return row + '</tr>';
    }).join('');

    syncHeaderHeight();
  }

  function renderUpdated() {
    const count = `共 ${state.stocks.length} 隻`;
    const { ok, time } = state.live;
    let text;
    if (ok && time) {
      const [, mo, d, hms] = time.match(/^\d{4}\/(\d{2})\/(\d{2}) (\S+)/) || [];
      text = `即時：${Number(mo)}月${Number(d)}日 ${hms}${marketOpen() ? ' · 每分鐘更新' : ' · 已收市'}`;
    } else if (ok === false) {
      const t = state.prices.updated_at;
      text = `即時報價暫停${t ? `，顯示 ${fmtDateTime(t)} 資料` : ''}`;
    } else {
      const t = state.prices.updated_at;
      text = t ? `更新：${fmtDateTime(t)}` : '載入中…';
    }
    $('#updated').textContent = `${text} · ${count}`;
  }

  function renderJumpList() {
    $('#jump-list').innerHTML = state.stocks
      .map((s) => `<option value="${shortCode(s.symbol)} ${escapeHtml(displayName(s))}"></option>`)
      .join('');
  }

  // ---------- 搜尋並跳至股票 ----------
  function matches(s, q) {
    const lower = q.toLowerCase();
    return shortCode(s.symbol).includes(q.replace(/\.hk$/i, '').replace(/^0+/, ''))
      || displayName(s).toLowerCase().includes(lower);
  }
  function findStock(q) {
    q = String(q || '').trim();
    if (!q) return null;
    const sym = normalizeSymbol(q.split(/\s+/)[0]);
    if (sym && state.stocks.some((s) => s.symbol === sym)) return sym;
    const lower = q.toLowerCase();
    const hit = state.stocks.find((s) => displayName(s).toLowerCase().includes(lower));
    return hit ? hit.symbol : null;
  }

  function jumpTo(sym) {
    const th = document.querySelector(`#grid th[data-sym="${sym}"]`);
    if (!th) return false;
    const wrap = $('#wrap');
    const dateW = document.querySelector('#grid thead .date-col').getBoundingClientRect().width;
    const left = th.getBoundingClientRect().left - wrap.getBoundingClientRect().left + wrap.scrollLeft - dateW;
    wrap.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
    th.classList.remove('flash');
    void th.offsetWidth; // 重新觸發動畫
    th.classList.add('flash');
    return true;
  }

  function tryJump(fromSubmit) {
    const input = $('#jump');
    const sym = findStock(input.value);
    if (sym && jumpTo(sym)) {
      input.value = '';
      input.blur();
      notice('');
    } else if (fromSubmit && input.value.trim()) {
      notice(`找不到「${input.value.trim()}」`);
    }
  }

  // ---------- 走勢圖（全螢幕） ----------
  function openChart(sym) {
    state.selected = sym;
    history.replaceState(null, '', `#${sym}`);
    const dlg = $('#dlg-chart');
    if (!dlg.open) dlg.showModal();
    renderChart();
  }

  function renderChart() {
    const sym = state.selected;
    if (!sym) return;
    const d = stockData(sym);
    const meta = state.stocks.find((s) => s.symbol === sym) || { symbol: sym };
    const hist = (d?.history || []).slice(-state.chartDays);
    const price = priceOf(sym);
    $('#chart-title').textContent = `${displayName(meta)}（${shortCode(sym)}）${price != null ? '　現價 ' + fmt(price) : ''}`;
    document.querySelectorAll('#chart-range button').forEach((b) =>
      b.classList.toggle('on', Number(b.dataset.days) === state.chartDays));

    if (typeof Chart === 'undefined') { $('#chart-title').textContent += ' — 圖表元件載入失敗'; return; }

    Chart.defaults.font.size = 18;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

    const closes = hist.map((r, i) => (i === hist.length - 1 && d.current != null ? d.current : r.c));
    const data = {
      labels: hist.map((r) => fmtAxisDate(r.d)),
      datasets: [
        {
          label: '最高', data: hist.map((r) => r.h), borderColor: 'rgba(207,34,46,.55)', borderWidth: 1.5,
          pointRadius: 0, fill: '+1', backgroundColor: 'rgba(110,119,129,.15)', tension: 0,
        },
        {
          label: '最低', data: hist.map((r) => r.l), borderColor: 'rgba(5,80,174,.55)', borderWidth: 1.5,
          pointRadius: 0, fill: false, tension: 0,
        },
        {
          label: '收市／現價', data: closes, borderColor: '#24292f', borderWidth: 3,
          pointRadius: hist.length > 30 ? 0 : 5, pointBackgroundColor: '#24292f', fill: false, tension: 0,
        },
      ],
    };

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { boxWidth: 22, padding: 18 } },
        tooltip: {
          titleFont: { size: 20 },
          bodyFont: { size: 19 },
          padding: 12,
          callbacks: {
            title: (items) => fmtDateLong(hist[items[0].dataIndex].d),
            label: (c) => ` ${c.dataset.label}：${fmt(c.parsed.y)}`,
            afterBody: (items) => {
              const r = hist[items[0].dataIndex];
              return `波幅：${fmt(r.h - r.l)}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 16 } },
        y: { ticks: { callback: (v) => fmt(v) }, grid: { color: '#eef1f4' } },
      },
    };

    if (state.chart) state.chart.destroy();
    state.chart = new Chart($('#chart'), { type: 'line', data, options });
  }

  // ---------- 新增／移除（每次都寫入變動紀錄） ----------
  // 以逗號、空格或換行分隔；一行內若只有一個代號，其餘文字作為名稱
  function parseAddInput(text) {
    const items = [];
    const invalid = [];
    text.split(/\n+/).forEach((line) => {
      const tokens = line.split(/[,，、;；\s]+/).filter(Boolean);
      const syms = [];
      const words = [];
      tokens.forEach((t) => {
        const sym = normalizeSymbol(t);
        if (sym) syms.push(sym); else words.push(t);
      });
      if (syms.length === 1) {
        items.push({ symbol: syms[0], name: words.join(' ') });
      } else {
        syms.forEach((s) => items.push({ symbol: s, name: '' }));
        invalid.push(...words);
      }
    });
    return { items, invalid };
  }

  const logEntry = (a, s) => ({
    t: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    a,
    symbol: s.symbol,
    name: s.name || stockData(s.symbol)?.name || '',
    price: priceOf(s.symbol),
  });

  // items: [{symbol, name}]
  async function addStocks(items) {
    // 先下載新股票的資料，令變動紀錄有加入時的價格
    const missing = missingData(items.map((i) => i.symbol));
    if (missing.length) await fetchHistory(missing);
    const res = await commitWatchlist((doc) => {
      const have = new Set(doc.stocks.map((s) => s.symbol));
      const added = [];
      const dup = [];
      items.forEach((it) => {
        if (have.has(it.symbol)) { dup.push(shortCode(it.symbol)); return; }
        have.add(it.symbol);
        const s = { symbol: it.symbol, name: (it.name || '').trim() || hkName(it.symbol) };
        doc.stocks.push(s);
        doc.log.push(logEntry('add', s));
        added.push(s);
      });
      return { changed: added.length > 0, added, dup };
    }, items.length === 1 ? `新增 ${items[0].symbol}` : `新增 ${items.length} 隻股票`);

    if (res.added.length) refreshLive();
    return res;
  }

  async function removeStocks(symbols) {
    const want = new Set(symbols);
    return commitWatchlist((doc) => {
      const removed = doc.stocks.filter((s) => want.has(s.symbol));
      doc.stocks = doc.stocks.filter((s) => !want.has(s.symbol));
      removed.forEach((s) => doc.log.push(logEntry('remove', s)));
      return { changed: removed.length > 0, removed };
    }, symbols.length === 1 ? `移除 ${symbols[0]}` : `移除 ${symbols.length} 隻股票`);
  }

  const label = (list) => (list.length === 1
    ? `${displayName(list[0])}（${shortCode(list[0].symbol)}）`
    : `${list.length} 隻股票`);

  // 移除後顯示「復原」，按下即重新加入
  async function removeWithUndo(symbols) {
    if (!canEdit()) { needToken(); return; }
    toast('移除中…');
    try {
      const { removed } = await removeStocks(symbols);
      if (!removed.length) { hideToast(); return; }
      toast(`已移除 ${label(removed)}`, async () => {
        toast('復原中…');
        try {
          await addStocks(removed.map((s) => ({ symbol: s.symbol, name: s.name })));
          toast(`已重新加入 ${label(removed)}`);
        } catch (e) {
          toast(`復原失敗：${e.message}`);
        }
      });
    } catch (e) {
      toast(`移除失敗：${e.message}`);
    }
  }

  async function addWithFeedback(items) {
    if (!canEdit()) { needToken(); return null; }
    toast('加入中…');
    try {
      const { added, dup } = await addStocks(items);
      const dupText = dup.length ? `（已在列表：${dup.join('、')}）` : '';
      if (!added.length) { toast(`沒有新股票${dupText}`); return { added, dup }; }
      toast(`已加入 ${label(added)}${dupText}`, () => removeWithUndo(added.map((s) => s.symbol)));
      return { added, dup };
    } catch (e) {
      toast(`加入失敗：${e.message}`);
      return null;
    }
  }

  function needToken() {
    notice('新增／移除股票需要 GitHub 權杖，請先在「設定」中輸入。');
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    $('#btn-settings').click();
  }

  // ---------- 管理股票畫面 ----------
  function openManage(tab = 'list', focusAdd = false) {
    state.mgTab = tab;
    const dlg = $('#dlg-manage');
    if (!dlg.open) dlg.showModal();
    renderManage();
    if (focusAdd) setTimeout(() => (qaBulk() ? $('#qa-bulk') : $('#qa-input')).focus(), 50);
  }
  const qaBulk = () => !$('#qa-bulk').hidden;

  function renderManage() {
    if (!$('#dlg-manage').open) return;
    $('#mg-count').textContent = `(${state.stocks.length})`;
    document.querySelectorAll('#mg-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.mgTab));
    $('#mg-panel-list').hidden = state.mgTab !== 'list';
    $('#mg-panel-log').hidden = state.mgTab !== 'log';
    const edit = canEdit();
    ['#qa-input', '#qa-bulk', '#qa-ok', '#qa-toggle', '#mg-all'].forEach((s) => { $(s).disabled = !edit; });
    if (!edit) qaMsg('需要在「設定」輸入 GitHub 權杖才可新增／移除（紀錄仍可瀏覽）。');
    if (state.mgTab === 'list') renderManageList(); else renderLog();
  }

  function renderManageList() {
    const q = $('#mg-filter').value.trim();
    const list = q ? state.stocks.filter((s) => matches(s, q)) : state.stocks;
    const edit = canEdit();
    $('#mg-list').innerHTML = list.length ? list.map((s) => {
      const sel = state.mgSel.has(s.symbol);
      const added = addedAt(s.symbol);
      return `<div class="mg-row${sel ? ' sel' : ''}" data-sym="${s.symbol}">
        <input type="checkbox" data-pick="${s.symbol}" ${sel ? 'checked' : ''} ${edit ? '' : 'disabled'} aria-label="選擇">
        <span class="code">${shortCode(s.symbol)}</span>
        <span class="nm"><button data-goto="${s.symbol}">${escapeHtml(displayName(s))}</button></span>
        <span class="num">${fmt(priceOf(s.symbol))}</span>
        <span class="when">${added ? '加入 ' + fmtLogTime(added.t).split(' ')[0] : ''}</span>
        <button class="rm" data-rm="${s.symbol}" ${edit ? '' : 'disabled'}>移除</button>
      </div>`;
    }).join('') : `<p class="mg-empty">${q ? '沒有符合的股票' : '列表是空的，請在上方輸入代號加入。'}</p>`;

    const visible = list.map((s) => s.symbol);
    const allOn = visible.length > 0 && visible.every((s) => state.mgSel.has(s));
    $('#mg-all').checked = allOn;
    const n = state.mgSel.size;
    $('#mg-remove-sel').disabled = !edit || n === 0;
    $('#mg-remove-sel').textContent = n ? `移除所選（${n}）` : '移除所選';
  }

  function renderLog() {
    const f = state.logFilter;
    document.querySelectorAll('#log-filter button').forEach((b) => b.classList.toggle('on', b.dataset.f === f));
    const live = new Set(state.stocks.map((s) => s.symbol));
    const entries = state.log.map((e, i) => ({ ...e, i })).filter((e) => f === 'all' || e.a === f).reverse();
    const adds = state.log.filter((e) => e.a === 'add').length;
    $('#log-summary').textContent = `共 ${state.log.length} 項：新增 ${adds}，移除 ${state.log.length - adds}`;
    const edit = canEdit();

    $('#log-list').innerHTML = entries.length ? entries.map((e) => {
      const ref = refPrice(e);
      const cur = live.has(e.symbol) ? priceOf(e.symbol) : null;
      const chg = e.a === 'add' && ref && cur != null ? ((cur - ref) / ref) * 100 : null;
      const cls = chg == null ? '' : chg > 0 ? 'up' : chg < 0 ? 'down' : '';
      let tail;
      if (e.a === 'add') {
        tail = live.has(e.symbol)
          ? (chg != null ? `<span class="num ${cls}">${signed(chg, 2)}%<span class="sub2">加入至今</span></span>` : '<span class="when-r">列表中</span>')
          : '<span class="when-r">已移除</span>';
      } else {
        tail = live.has(e.symbol)
          ? '<span class="when-r">已重新加入</span>'
          : `<button data-readd="${e.i}" ${edit ? '' : 'disabled'}>重新加入</button>`;
      }
      return `<div class="mg-row">
        <span class="when">${fmtLogTime(e.t)}</span>
        <span class="badge badge-${e.a}">${e.a === 'add' ? '新增' : '移除'}</span>
        <span class="code">${shortCode(e.symbol)}</span>
        <span class="nm">${escapeHtml(e.name || e.symbol)}</span>
        <span class="num hide-narrow">${fmt(ref)}<span class="sub2">當時價格</span></span>
        ${tail}
        <span class="hide-narrow"></span>
      </div>`;
    }).join('') : '<p class="mg-empty">尚未有變動紀錄。</p>';
  }

  function qaMsg(text, err) {
    $('#qa-msg').textContent = text || '';
    $('#qa-msg').className = err ? 'small err' : 'small';
  }
  function qaText() { return qaBulk() ? $('#qa-bulk').value : $('#qa-input').value; }

  function renderAll() {
    renderUpdated();
    renderTable();
    renderJumpList();
    renderManage();
  }

  // ---------- 事件 ----------
  function bindEvents() {
    $('#grid thead').addEventListener('click', (ev) => {
      const rm = ev.target.closest('[data-remove]');
      if (rm) { removeWithUndo([rm.dataset.remove]); return; }
      const ch = ev.target.closest('[data-chart]');
      if (ch) openChart(ch.dataset.chart);
    });

    $('#form-jump').addEventListener('submit', (ev) => { ev.preventDefault(); tryJump(true); });
    $('#jump').addEventListener('change', () => tryJump(false));

    // 走勢圖
    const dlgChart = $('#dlg-chart');
    $('#chart-range').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-days]');
      if (!b) return;
      state.chartDays = Number(b.dataset.days);
      renderChart();
    });
    $('#chart-close').addEventListener('click', () => dlgChart.close());
    dlgChart.addEventListener('close', () => {
      state.selected = null;
      history.replaceState(null, '', location.pathname + location.search);
    });

    // 管理股票
    const dlgManage = $('#dlg-manage');
    $('#btn-add').addEventListener('click', () => (canEdit() ? openManage('list', true) : needToken()));
    $('#btn-manage').addEventListener('click', () => openManage('list'));
    $('#mg-close').addEventListener('click', () => dlgManage.close());
    dlgManage.addEventListener('close', () => {
      // 提示框移回頁面，避免隨對話框隱藏
      document.body.appendChild($('#toast'));
    });
    $('#mg-tabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-tab]');
      if (!b) return;
      state.mgTab = b.dataset.tab;
      renderManage();
    });

    $('#qa-toggle').addEventListener('click', () => {
      const bulk = !qaBulk();
      $('#qa-bulk').hidden = !bulk;
      $('#qa-input').hidden = bulk;
      if (bulk && $('#qa-input').value) $('#qa-bulk').value = $('#qa-input').value;
      $('#qa-toggle').textContent = bulk ? '單行' : '批量';
      (bulk ? $('#qa-bulk') : $('#qa-input')).focus();
    });
    const preview = () => {
      const { items, invalid } = parseAddInput(qaText());
      if (invalid.length) { qaMsg(`無法辨認：${invalid.join('、')}`, true); return; }
      if (!items.length) { qaMsg(''); return; }
      const haveNames = Object.keys(state.names).length > 0;
      const unknown = haveNames ? items.filter((i) => !hkName(i.symbol)).map((i) => shortCode(i.symbol)) : [];
      const shown = items.slice(0, 10).map((i) => `${shortCode(i.symbol)} ${i.name || hkName(i.symbol)}`.trim()).join('、');
      qaMsg(`將會加入 ${items.length} 隻：${shown}${items.length > 10 ? '…' : ''}`
        + (unknown.length ? `\n港交所名單找不到：${unknown.join('、')}（請檢查代號）` : ''), unknown.length > 0);
    };
    $('#qa-input').addEventListener('input', preview);
    $('#qa-bulk').addEventListener('input', preview);
    $('#form-quickadd').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const { items, invalid } = parseAddInput(qaText());
      if (invalid.length) { qaMsg(`無法辨認：${invalid.join('、')}`, true); return; }
      if (!items.length) { qaMsg('請輸入股票代號，例如 700 或 0700.HK', true); return; }
      $('#qa-ok').disabled = true;
      qaMsg('儲存中…');
      const res = await addWithFeedback(items);
      $('#qa-ok').disabled = false;
      if (res) {
        $('#qa-input').value = '';
        $('#qa-bulk').value = '';
        qaMsg('');
        $('#mg-filter').value = '';
        renderManageList();
        $('#mg-list').scrollTop = $('#mg-list').scrollHeight; // 新加入的在最後
        if (!qaBulk()) $('#qa-input').focus();
      } else {
        qaMsg('');
      }
    });

    $('#mg-filter').addEventListener('input', renderManageList);
    $('#mg-all').addEventListener('change', () => {
      const q = $('#mg-filter').value.trim();
      const visible = (q ? state.stocks.filter((s) => matches(s, q)) : state.stocks).map((s) => s.symbol);
      visible.forEach((s) => ($('#mg-all').checked ? state.mgSel.add(s) : state.mgSel.delete(s)));
      renderManageList();
    });
    $('#mg-list').addEventListener('click', (ev) => {
      const rm = ev.target.closest('[data-rm]');
      if (rm) { removeWithUndo([rm.dataset.rm]); return; }
      const go = ev.target.closest('[data-goto]');
      if (go) { dlgManage.close(); jumpTo(go.dataset.goto); return; }
      const row = ev.target.closest('.mg-row');
      if (!row || !canEdit()) return;
      const sym = row.dataset.sym;
      // 點擊整行（或勾選框）切換選取
      if (state.mgSel.has(sym)) state.mgSel.delete(sym); else state.mgSel.add(sym);
      renderManageList();
    });
    $('#mg-remove-sel').addEventListener('click', async () => {
      const syms = [...state.mgSel];
      if (!syms.length) return;
      state.mgSel.clear();
      await removeWithUndo(syms);
      renderManageList();
    });

    $('#log-filter').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-f]');
      if (!b) return;
      state.logFilter = b.dataset.f;
      renderLog();
    });
    $('#log-list').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-readd]');
      if (!b) return;
      const e = state.log[Number(b.dataset.readd)];
      if (e) addWithFeedback([{ symbol: e.symbol, name: e.name }]);
    });

    // 設定
    const dlgSet = $('#dlg-settings');
    $('#btn-settings').addEventListener('click', () => {
      $('#set-repo').value = settings.repo;
      $('#set-branch').value = settings.branch;
      $('#set-token').value = settings.token;
      dlgSet.showModal();
    });
    $('#form-settings').addEventListener('submit', async (ev) => {
      const v = ev.submitter?.value;
      if (v === 'cancel') return;
      if (v === 'clear') {
        settings = { ...settings, token: '' };
      } else {
        settings = {
          repo: $('#set-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, ''),
          branch: $('#set-branch').value.trim() || 'main',
          token: $('#set-token').value.trim(),
        };
      }
      saveSettings(settings);
      notice(canEdit() ? '設定已儲存，可新增／移除股票。' : '');
      await load();
    });

    window.addEventListener('resize', syncHeaderHeight);

    // 交易時段內每分鐘更新；iPad 由休眠／其他分頁返回時立即更新
    setInterval(() => {
      if (document.visibilityState === 'visible' && marketOpen()) refreshLive();
    }, LIVE_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshLive();
    });
  }

  async function load() {
    try {
      const [stocksJson, prices, names] = await Promise.all([
        loadStocksJson(),
        fetchStatic('data/prices.json').catch(() => ({ stocks: {} })),
        fetchStatic('data/names.json').catch(() => ({})),
      ]);
      state.prices = prices;
      state.names = names;
      applyDoc(stocksJson);
    } catch (e) {
      notice(`載入資料失敗：${e.message}`);
      renderAll();
    }

    refreshLive();

    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash === 'manage' || hash === 'log') { openManage(hash === 'log' ? 'log' : 'list'); return; }
    const want = normalizeSymbol(hash);
    if (want && state.stocks.some((s) => s.symbol === want) && !$('#dlg-chart').open) openChart(want);
  }

  bindEvents();
  load();
})();
