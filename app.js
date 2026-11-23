(() => {
  'use strict';

  const TABLE_DAYS = 14;
  const LS_KEY = 'dailystock.settings';
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  const $ = (sel) => document.querySelector(sel);
  const state = { stocks: [], prices: { stocks: {} }, selected: null, chartDays: 14, chart: null, polling: null };

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
  function signed(v, digits) {
    return (v > 0 ? '+' : '') + fmt(v, digits);
  }
  function parseIso(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return { y, m, d, wd: WEEKDAYS[new Date(y, m - 1, d).getDay()] };
  }
  const fmtDateShort = (iso) => { const p = parseIso(iso); return `${p.m}/${p.d}（${p.wd}）`; };
  const fmtDateLong = (iso) => { const p = parseIso(iso); return `${p.y}年${p.m}月${p.d}日（${p.wd}）`; };
  const fmtAxisDate = (iso) => { const p = parseIso(iso); return `${p.m}/${p.d}`; };
  function fmtDateTime(isoTs) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(isoTs)).reduce((a, p) => (a[p.type] = p.value, a), {});
    return `${Number(parts.month)}月${Number(parts.day)}日 ${parts.hour}:${parts.minute}`;
  }

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
      throw new Error(msg);
    }
    return res;
  }

  async function fetchStatic(path) {
    const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
  }

  // 有權杖時直接從儲存庫讀取最新的 stocks.json（避免網站發佈延遲）
  async function loadStocksJson() {
    if (canEdit()) {
      try {
        const res = await gh(`/contents/stocks.json?ref=${encodeURIComponent(settings.branch)}`, {
          headers: { Accept: 'application/vnd.github.raw+json' },
        });
        return await res.json();
      } catch (e) {
        console.warn('GitHub API 讀取失敗，改用網站檔案', e);
      }
    }
    return fetchStatic('stocks.json');
  }

  function b64utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  async function commitStocks(list, message) {
    const meta = await (await gh(`/contents/stocks.json?ref=${encodeURIComponent(settings.branch)}`)).json();
    const body = JSON.stringify({ stocks: list }, null, 2) + '\n';
    await gh('/contents/stocks.json', {
      method: 'PUT',
      body: JSON.stringify({ message, content: b64utf8(body), sha: meta.sha, branch: settings.branch }),
    });
  }

  // ---------- 提示 ----------
  function notice(text) {
    const el = $('#notice');
    el.textContent = text || '';
    el.hidden = !text;
  }

  // ---------- 表格 ----------
  const stockData = (sym) => state.prices.stocks?.[sym] || null;
  const displayName = (s) => s.name || stockData(s.symbol)?.name || s.symbol;

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
    const t = state.prices.updated_at;
    $('#updated').textContent = t
      ? `更新：${fmtDateTime(t)}（香港時間）· 共 ${state.stocks.length} 隻`
      : '尚未有資料';
  }

  function renderJumpList() {
    $('#jump-list').innerHTML = state.stocks
      .map((s) => `<option value="${shortCode(s.symbol)} ${escapeHtml(displayName(s))}"></option>`)
      .join('');
  }

  // ---------- 搜尋並跳至股票 ----------
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
    const price = d?.current ?? d?.history?.[d.history.length - 1]?.c;
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

  // ---------- 新增／移除 ----------
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

  async function addStocks(text) {
    const { items, invalid } = parseAddInput(text);
    if (invalid.length) throw new Error(`無法辨認：${invalid.join('、')}`);
    if (!items.length) throw new Error('請輸入股票代號，例如 700 或 0700.HK');

    const existing = new Set(state.stocks.map((s) => s.symbol));
    const seen = new Set();
    const toAdd = [];
    const dup = [];
    items.forEach((it) => {
      if (existing.has(it.symbol) || seen.has(it.symbol)) { dup.push(shortCode(it.symbol)); return; }
      seen.add(it.symbol);
      toAdd.push(it);
    });
    if (!toAdd.length) throw new Error(`全部已在列表中：${dup.join('、')}`);

    const list = [...state.stocks, ...toAdd];
    const label = toAdd.length === 1 ? toAdd[0].symbol : `${toAdd.length} 隻股票`;
    await commitStocks(list, `新增 ${label}`);
    state.stocks = list;
    renderAll();
    notice(`已新增 ${label}${dup.length ? `（略過重複：${dup.join('、')}）` : ''}，正在下載資料及更新網站（約 2 分鐘）…`);
    pollFor(toAdd.map((t) => t.symbol));
  }

  async function removeStock(sym) {
    const meta = state.stocks.find((s) => s.symbol === sym);
    if (!confirm(`確定移除「${meta ? displayName(meta) : sym}」？`)) return;
    const list = state.stocks.filter((s) => s.symbol !== sym);
    try {
      await commitStocks(list, `移除 ${sym}`);
      state.stocks = list;
      renderAll();
      notice(`已移除 ${sym}`);
    } catch (e) {
      notice(`移除失敗：${e.message}`);
    }
  }

  function pollFor(symbols) {
    clearInterval(state.polling);
    let tries = 0;
    state.polling = setInterval(async () => {
      tries += 1;
      try {
        state.prices = await fetchStatic('data/prices.json');
        if (symbols.every((s) => stockData(s)?.history?.length)) {
          clearInterval(state.polling);
          notice('新股票資料已更新');
          renderAll();
          return;
        }
      } catch (e) { /* 下次再試 */ }
      if (tries >= 15) {
        clearInterval(state.polling);
        renderAll();
        notice('部分資料尚未出現，請稍後重新整理頁面。');
      }
    }, 20000);
  }

  function renderAll() {
    renderUpdated();
    renderTable();
    renderJumpList();
  }

  // ---------- 事件 ----------
  function bindEvents() {
    $('#grid thead').addEventListener('click', (ev) => {
      const rm = ev.target.closest('[data-remove]');
      if (rm) { removeStock(rm.dataset.remove); return; }
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

    // 新增
    const dlgAdd = $('#dlg-add');
    const addMsg = (text, err) => { $('#add-msg').textContent = text; $('#add-msg').className = err ? 'small err' : 'small'; };
    $('#btn-add').addEventListener('click', () => {
      if (!canEdit()) {
        notice('新增／移除股票需要 GitHub 權杖，請先在「設定」中輸入。');
        $('#btn-settings').click();
        return;
      }
      $('#form-add').reset();
      addMsg('');
      dlgAdd.showModal();
      $('#add-input').focus();
    });
    $('#add-input').addEventListener('input', () => {
      const { items, invalid } = parseAddInput($('#add-input').value);
      if (invalid.length) addMsg(`無法辨認：${invalid.join('、')}`, true);
      else addMsg(items.length ? `將會加入 ${items.length} 隻：${items.slice(0, 8).map((i) => shortCode(i.symbol)).join('、')}${items.length > 8 ? '…' : ''}` : '');
    });
    $('#form-add').addEventListener('submit', async (ev) => {
      if (ev.submitter?.value !== 'ok') return;
      ev.preventDefault();
      const btn = $('#add-ok');
      btn.disabled = true;
      addMsg('儲存中…');
      try {
        await addStocks($('#add-input').value);
        dlgAdd.close();
      } catch (e) {
        addMsg(e.message, true);
      } finally {
        btn.disabled = false;
      }
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
  }

  async function load() {
    try {
      const [stocksJson, prices] = await Promise.all([
        loadStocksJson(),
        fetchStatic('data/prices.json').catch(() => ({ stocks: {} })),
      ]);
      state.stocks = stocksJson.stocks || [];
      state.prices = prices;
    } catch (e) {
      notice(`載入資料失敗：${e.message}`);
    }
    renderAll();

    const want = normalizeSymbol(decodeURIComponent(location.hash.slice(1)));
    if (want && state.stocks.some((s) => s.symbol === want) && !$('#dlg-chart').open) openChart(want);
  }

  bindEvents();
  load();
})();
