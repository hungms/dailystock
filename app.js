(() => {
  'use strict';

  const TABLE_DAYS = 14;
  const WORKFLOW_FILE = 'update.yml';
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
  function fmtDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
    return `${y}年${m}月${d}日（${wd}）`;
  }
  function fmtShortDate(iso) {
    const [, m, d] = iso.split('-').map(Number);
    return `${m}/${d}`;
  }
  function fmtDateTime(isoTs) {
    const t = new Date(isoTs);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(t).reduce((a, p) => (a[p.type] = p.value, a), {});
    return `${parts.year}年${Number(parts.month)}月${Number(parts.day)}日 ${parts.hour}:${parts.minute}（香港時間）`;
  }

  function normalizeSymbol(raw) {
    let s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
    s = s.replace(/\.HK$/, '');
    if (!/^\d{1,5}$/.test(s)) return null;
    s = s.replace(/^0+/, '') || '0';
    return s.padStart(4, '0') + '.HK';
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
    return res.status === 204 ? null : res;
  }

  // 有權杖時直接從儲存庫讀取最新檔案（避免 GitHub Pages 延遲）；否則讀取靜態檔案
  async function loadJson(path) {
    if (canEdit()) {
      try {
        const res = await gh(`/contents/${path}?ref=${encodeURIComponent(settings.branch)}`, {
          headers: { Accept: 'application/vnd.github.raw+json' },
        });
        return await res.json();
      } catch (e) {
        console.warn('GitHub API 讀取失敗，改用靜態檔案', e);
      }
    }
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

  async function commitStocks(list, message) {
    const meta = await (await gh(`/contents/stocks.json?ref=${encodeURIComponent(settings.branch)}`)).json();
    const body = JSON.stringify({ stocks: list }, null, 2) + '\n';
    await gh('/contents/stocks.json', {
      method: 'PUT',
      body: JSON.stringify({ message, content: b64utf8(body), sha: meta.sha, branch: settings.branch }),
    });
  }

  async function triggerUpdate() {
    await gh(`/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: settings.branch }),
    });
  }

  // ---------- 提示 ----------
  function notice(text) {
    const el = $('#notice');
    el.textContent = text || '';
    el.hidden = !text;
  }

  // ---------- 表格 ----------
  function stockData(sym) {
    return state.prices.stocks?.[sym] || null;
  }

  function renderTable() {
    const thead = $('#grid thead');
    const tbody = $('#grid tbody');
    const stocks = state.stocks;

    if (!stocks.length) {
      thead.innerHTML = '';
      tbody.innerHTML = '<tr><td class="empty">尚未加入任何股票，請按「＋ 新增股票」。</td></tr>';
      return;
    }

    // 所有股票的交易日合併，取最近 14 日，新到舊
    const dateSet = new Set();
    stocks.forEach((s) => (stockData(s.symbol)?.history || []).forEach((r) => dateSet.add(r.d)));
    const dates = [...dateSet].sort().reverse().slice(0, TABLE_DAYS);

    let h1 = '<tr><th class="date-col" rowspan="2">日期</th>';
    let h2 = '<tr>';
    stocks.forEach((s) => {
      const d = stockData(s.symbol);
      const name = s.name || d?.name || s.symbol;
      const active = state.selected === s.symbol ? ' active' : '';
      const rm = canEdit() ? `<button class="remove" data-remove="${s.symbol}" title="移除">✕</button>` : '';
      h1 += `<th colspan="4" class="grp-start"><span class="stock-head">
        <button class="stock-name${active}" data-chart="${s.symbol}">${escapeHtml(name)}</button>
        <span class="code">${s.symbol.replace('.HK', '')}</span>${rm}</span></th>`;
      h2 += '<th class="grp-start">最高</th><th>最低</th><th>波幅</th><th>現價</th>';
    });
    thead.innerHTML = h1 + '</tr>' + h2 + '</tr>';

    const lookups = stocks.map((s) => {
      const hist = stockData(s.symbol)?.history || [];
      const map = new Map();
      hist.forEach((r, i) => map.set(r.d, { r, prev: hist[i - 1] || null, last: i === hist.length - 1 }));
      return { s, map, current: stockData(s.symbol)?.current };
    });

    if (!dates.length) {
      tbody.innerHTML = `<tr><td class="date-col">—</td>${stocks.map(() =>
        '<td class="grp-start empty" colspan="4">等待資料更新…</td>').join('')}</tr>`;
      return;
    }

    tbody.innerHTML = dates.map((date, idx) => {
      let row = `<tr${idx === 0 ? ' class="today"' : ''}><td class="date-col">${fmtDate(date)}</td>`;
      lookups.forEach(({ map, current }) => {
        const hit = map.get(date);
        if (!hit) {
          row += `<td class="grp-start empty" colspan="4">${map.size ? '—' : '等待資料更新…'}</td>`;
          return;
        }
        const { r, prev, last } = hit;
        const price = last && current != null ? current : r.c;
        const range = r.h - r.l;
        const pct = r.l ? (range / r.l) * 100 : null;
        let cls = '';
        let chg = '';
        if (prev) {
          const diff = price - prev.c;
          cls = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
          const dp = prev.c ? (diff / prev.c) * 100 : 0;
          chg = ` <span class="pct">${diff > 0 ? '+' : ''}${fmt(dp, 2)}%</span>`;
        }
        const dg = r.l < 10 ? 3 : 2;
        row += `<td class="grp-start">${fmt(r.h, dg)}</td><td>${fmt(r.l, dg)}</td>
          <td>${fmt(range, dg)} <span class="pct">(${fmt(pct, 2)}%)</span></td>
          <td class="${cls}">${fmt(price, dg)}${chg}</td>`;
      });
      return row + '</tr>';
    }).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderUpdated() {
    const t = state.prices.updated_at;
    $('#updated').textContent = t ? `資料更新：${fmtDateTime(t)}` : '尚未有資料';
    $('#btn-add').title = canEdit() ? '' : '請先在「設定」輸入 GitHub 權杖';
  }

  // ---------- 走勢圖 ----------
  function renderChart() {
    const panel = $('#chart-panel');
    const sym = state.selected;
    const d = sym && stockData(sym);
    if (!sym) { panel.hidden = true; return; }
    panel.hidden = false;

    const meta = state.stocks.find((s) => s.symbol === sym);
    const name = meta?.name || d?.name || sym;
    $('#chart-title').textContent = `${name}（${sym.replace('.HK', '')}）`;
    document.querySelectorAll('#chart-range button').forEach((b) =>
      b.classList.toggle('on', Number(b.dataset.days) === state.chartDays));

    const hist = (d?.history || []).slice(-state.chartDays);
    if (typeof Chart === 'undefined') { $('#chart-title').textContent += ' — 圖表元件載入失敗'; return; }

    const labels = hist.map((r) => fmtShortDate(r.d));
    const highs = hist.map((r) => r.h);
    const lows = hist.map((r) => r.l);
    const closes = hist.map((r, i) => (i === hist.length - 1 && d.current != null ? d.current : r.c));

    const data = {
      labels,
      datasets: [
        {
          label: '最高', data: highs, borderColor: 'rgba(9,105,218,.45)', borderWidth: 1,
          pointRadius: 0, fill: '+1', backgroundColor: 'rgba(9,105,218,.12)', tension: 0,
        },
        {
          label: '最低', data: lows, borderColor: 'rgba(9,105,218,.45)', borderWidth: 1,
          pointRadius: 0, fill: false, tension: 0,
        },
        {
          label: '收市／現價', data: closes, borderColor: '#0969da', borderWidth: 2,
          pointRadius: hist.length > 30 ? 0 : 3, pointBackgroundColor: '#0969da', fill: false, tension: 0,
        },
      ],
    };

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { boxWidth: 14 } },
        tooltip: {
          callbacks: {
            title: (items) => fmtDate(hist[items[0].dataIndex].d),
            label: (c) => ` ${c.dataset.label}：${fmt(c.parsed.y)}`,
            afterBody: (items) => {
              const r = hist[items[0].dataIndex];
              return `波幅：${fmt(r.h - r.l)}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false } },
        y: { ticks: { callback: (v) => fmt(v) }, grid: { color: '#eef1f4' } },
      },
    };

    if (state.chart) state.chart.destroy();
    state.chart = new Chart($('#chart'), { type: 'line', data, options });
  }

  // ---------- 新增／移除 ----------
  async function addStock(rawSymbol, name) {
    const sym = normalizeSymbol(rawSymbol);
    if (!sym) throw new Error('代號格式不正確，請輸入數字代號，例如 700 或 0700.HK');
    if (state.stocks.some((s) => s.symbol === sym)) throw new Error(`${sym} 已在列表中`);
    const list = [...state.stocks, { symbol: sym, name: name.trim() }];
    await commitStocks(list, `新增股票 ${sym}`);
    state.stocks = list;
    renderTable();
    try {
      await triggerUpdate();
      notice(`已新增 ${sym}，正在下載資料（約 1–2 分鐘）…`);
      pollFor(sym);
    } catch (e) {
      notice(`已新增 ${sym}，但無法自動觸發更新（${e.message}），資料將於下次排程更新時出現。`);
    }
  }

  async function removeStock(sym) {
    const meta = state.stocks.find((s) => s.symbol === sym);
    if (!confirm(`確定移除「${meta?.name || sym}」？`)) return;
    const list = state.stocks.filter((s) => s.symbol !== sym);
    try {
      await commitStocks(list, `移除股票 ${sym}`);
      state.stocks = list;
      if (state.selected === sym) state.selected = null;
      renderTable();
      renderChart();
      notice(`已移除 ${sym}`);
    } catch (e) {
      notice(`移除失敗：${e.message}`);
    }
  }

  function pollFor(sym) {
    clearInterval(state.polling);
    let tries = 0;
    state.polling = setInterval(async () => {
      tries += 1;
      try {
        state.prices = await loadJson('data/prices.json');
        if (stockData(sym)?.history?.length) {
          clearInterval(state.polling);
          notice(`${sym} 資料已更新`);
          renderAll();
        }
      } catch (e) { /* 下次再試 */ }
      if (tries >= 15) {
        clearInterval(state.polling);
        notice(`${sym} 資料尚未出現，請稍後重新整理頁面。`);
      }
    }, 20000);
  }

  function syncHash() {
    history.replaceState(null, '', state.selected ? `#${state.selected}` : location.pathname + location.search);
  }

  function renderAll() {
    renderUpdated();
    renderTable();
    renderChart();
  }

  // ---------- 事件 ----------
  function bindEvents() {
    $('#grid thead').addEventListener('click', (ev) => {
      const rm = ev.target.closest('[data-remove]');
      if (rm) { removeStock(rm.dataset.remove); return; }
      const ch = ev.target.closest('[data-chart]');
      if (ch) {
        const sym = ch.dataset.chart;
        state.selected = state.selected === sym ? null : sym;
        syncHash();
        renderTable();
        renderChart();
        if (state.selected) $('#chart-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });

    $('#chart-range').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-days]');
      if (!b) return;
      state.chartDays = Number(b.dataset.days);
      renderChart();
    });
    $('#chart-close').addEventListener('click', () => {
      state.selected = null;
      syncHash();
      renderTable();
      renderChart();
    });

    const dlgAdd = $('#dlg-add');
    $('#btn-add').addEventListener('click', () => {
      if (!canEdit()) {
        notice('新增／移除股票需要 GitHub 權杖，請先在「設定」中輸入。');
        $('#btn-settings').click();
        return;
      }
      $('#form-add').reset();
      $('#add-msg').textContent = '';
      $('#add-msg').className = 'small';
      dlgAdd.showModal();
      $('#add-symbol').focus();
    });
    $('#add-symbol').addEventListener('input', () => {
      const sym = normalizeSymbol($('#add-symbol').value);
      $('#add-msg').className = 'small';
      $('#add-msg').textContent = sym ? `將會加入：${sym}` : '';
    });
    $('#form-add').addEventListener('submit', async (ev) => {
      if (ev.submitter?.value !== 'ok') return;
      ev.preventDefault();
      const btn = $('#add-ok');
      btn.disabled = true;
      $('#add-msg').className = 'small';
      $('#add-msg').textContent = '儲存中…';
      try {
        await addStock($('#add-symbol').value, $('#add-name').value);
        dlgAdd.close();
      } catch (e) {
        $('#add-msg').className = 'small err';
        $('#add-msg').textContent = e.message;
      } finally {
        btn.disabled = false;
      }
    });

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
  }

  async function load() {
    try {
      const [stocksJson, prices] = await Promise.all([
        loadJson('stocks.json'),
        loadJson('data/prices.json').catch(() => ({ stocks: {} })),
      ]);
      state.stocks = stocksJson.stocks || [];
      state.prices = prices;
      const want = normalizeSymbol(decodeURIComponent(location.hash.slice(1)));
      if (!state.selected && want && state.stocks.some((s) => s.symbol === want)) state.selected = want;
    } catch (e) {
      notice(`載入資料失敗：${e.message}`);
    }
    renderAll();
  }

  bindEvents();
  load();
})();
