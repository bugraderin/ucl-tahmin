import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

/* ==================================================================== */
/*  Kurulum kontrolü                                                    */
/* ==================================================================== */
const cfg = window.APP_CONFIG || {};
if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.startsWith('BURAYA')) {
  document.body.innerHTML =
    '<div class="empty" style="padding-top:80px">config.js dosyasındaki Supabase bilgilerini doldurman gerekiyor.<br>' +
    'Adımlar için README.md dosyasına bak.</div>';
  throw new Error('config.js doldurulmamış');
}

const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

/* ==================================================================== */
/*  Yardımcılar                                                          */
/* ==================================================================== */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TZ = 'Europe/Istanbul';
const fTime = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const fDay = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, day: 'numeric', month: 'long', weekday: 'long' });
const fKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

const timeOf = (iso) => fTime.format(new Date(iso));
const dayKey = (iso) => fKey.format(new Date(iso));
const dayLabel = (iso) => fDay.format(new Date(iso));

/** "3g 4sa", "5sa 12dk", "8 dk" */
function humanLeft(ms) {
  if (ms <= 0) return null;
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d} gün ${h % 24} saat`;
  if (h > 0) return `${h} saat ${m % 60} dk`;
  return `${m} dk`;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
}

/* ==================================================================== */
/*  Durum                                                                */
/* ==================================================================== */
const state = {
  user: null,
  displayName: '',
  matches: [],
  myPreds: new Map(),      // match_id -> {pick, home_score, away_score}
  allPreds: new Map(),     // match_id -> [{user_id, pick, ...}]
  profiles: new Map(),     // user_id -> display_name
  rounds: [],
  activeRound: null,
  view: 'matches',
};

const isLocked = (m) => new Date(m.lock_at).getTime() <= Date.now();
const isFinished = (m) => m.status === 'FINISHED';
const isLive = (m) => ['IN_PLAY', 'PAUSED'].includes(m.status);

function pointsFor(m, p) {
  if (!p || !isFinished(m) || m.result == null) return null;
  let pts = p.pick === m.result ? 3 : 0;
  if (p.home_score != null && p.home_score === m.home_score && p.away_score === m.away_score) pts += 2;
  return pts;
}

/* ==================================================================== */
/*  Kimlik doğrulama                                                     */
/* ==================================================================== */
let authMode = 'login';

document.querySelectorAll('.seg-btn').forEach((b) => {
  b.onclick = () => {
    authMode = b.dataset.mode;
    document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    $('.name-field').classList.toggle('hidden', authMode !== 'register');
    $('#f-name').required = authMode === 'register';
    $('#f-pass').autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
    $('#auth-submit').textContent = authMode === 'register' ? 'Kayıt ol' : 'Giriş yap';
    $('#auth-msg').textContent = '';
  };
});

$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('#auth-submit');
  const msg = $('#auth-msg');
  const email = $('#f-email').value.trim();
  const password = $('#f-pass').value;
  const name = $('#f-name').value.trim();

  btn.disabled = true;
  msg.className = 'auth-msg';
  msg.textContent = 'Bir saniye…';

  try {
    if (authMode === 'register') {
      if (name.length < 2) throw new Error('Görünen ad en az 2 karakter olmalı.');
      const { data, error } = await sb.auth.signUp({
        email, password, options: { data: { display_name: name } },
      });
      if (error) throw error;
      if (!data.session) {
        msg.textContent = 'Kaydın alındı. E-postana gelen doğrulama linkine tıkla, sonra giriş yap.';
        btn.disabled = false;
        return;
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    msg.className = 'auth-msg err';
    msg.textContent = translateAuthError(err.message);
    btn.disabled = false;
  }
};

function translateAuthError(m = '') {
  const s = m.toLowerCase();
  if (s.includes('invalid login')) return 'E-posta veya şifre hatalı.';
  if (s.includes('already registered')) return 'Bu e-posta zaten kayıtlı, giriş yapmayı dene.';
  if (s.includes('email not confirmed')) return 'E-postanı doğrulaman gerekiyor, gelen kutuna bak.';
  if (s.includes('password')) return 'Şifre en az 6 karakter olmalı.';
  if (s.includes('rate limit')) return 'Çok fazla deneme oldu, biraz bekle.';
  return m;
}

$('#logout').onclick = () => sb.auth.signOut();

/* ==================================================================== */
/*  Veri yükleme                                                         */
/* ==================================================================== */
async function loadAll() {
  const [mRes, pRes, prRes] = await Promise.all([
    sb.from('matches').select('*').order('utc_date', { ascending: true }),
    sb.from('predictions').select('user_id, match_id, pick, home_score, away_score'),
    sb.from('profiles').select('id, display_name'),
  ]);
  if (mRes.error) throw mRes.error;

  state.matches = mRes.data || [];

  state.profiles = new Map((prRes.data || []).map((p) => [p.id, p.display_name]));
  state.displayName = state.profiles.get(state.user.id) || state.user.email.split('@')[0];
  $('#me-name').textContent = state.displayName;

  state.myPreds = new Map();
  state.allPreds = new Map();
  for (const p of pRes.data || []) {
    if (p.user_id === state.user.id) state.myPreds.set(p.match_id, p);
    if (!state.allPreds.has(p.match_id)) state.allPreds.set(p.match_id, []);
    state.allPreds.get(p.match_id).push(p);
  }

  // Turlar, ilk maç tarihine göre sıralı
  const rounds = new Map();
  for (const m of state.matches) {
    const label = m.round_label || 'Maçlar';
    const t = new Date(m.utc_date).getTime();
    if (!rounds.has(label) || t < rounds.get(label)) rounds.set(label, t);
  }
  state.rounds = [...rounds.entries()].sort((a, b) => a[1] - b[1]).map(([label]) => label);

  if (!state.activeRound || !state.rounds.includes(state.activeRound)) {
    const next = state.matches.find((m) => !isLocked(m)) || state.matches[state.matches.length - 1];
    state.activeRound = next ? next.round_label : state.rounds[0];
  }
}

/* ==================================================================== */
/*  Tahmin kaydetme                                                      */
/* ==================================================================== */
async function savePrediction(match, patch) {
  const prev = state.myPreds.get(match.id) || {};
  const next = {
    user_id: state.user.id,
    match_id: match.id,
    pick: patch.pick ?? prev.pick,
    home_score: 'home_score' in patch ? patch.home_score : (prev.home_score ?? null),
    away_score: 'away_score' in patch ? patch.away_score : (prev.away_score ?? null),
    updated_at: new Date().toISOString(),
  };

  // İki skor da girildiyse 1/X/2 tahminini skorla uyumlu hale getir.
  if (next.home_score != null && next.away_score != null) {
    const derived = next.home_score > next.away_score ? '1'
                  : next.home_score === next.away_score ? 'X' : '2';
    if (next.pick !== derived) next.pick = derived;
  }
  if (!next.pick) return;

  state.myPreds.set(match.id, next);           // iyimser güncelleme
  renderMatches();

  const { error } = await sb.from('predictions').upsert(next, { onConflict: 'user_id,match_id' });
  if (error) {
    state.myPreds.set(match.id, prev.pick ? prev : undefined);
    if (!prev.pick) state.myPreds.delete(match.id);
    renderMatches();
    toast(error.message.includes('policy')
      ? 'Bu maç kilitlendi, tahmin değiştirilemez.'
      : 'Kaydedilemedi: ' + error.message, true);
  } else {
    toast(`${match.home_team} — ${match.away_team}: ${next.pick} kaydedildi`);
    renderReminder();
  }
}

/* ==================================================================== */
/*  Maçlar görünümü                                                      */
/* ==================================================================== */
function renderRoundBar() {
  const sel = $('#round-select');
  sel.innerHTML = '';
  for (const r of state.rounds) {
    const o = el('option');
    o.value = r; o.textContent = r;
    o.selected = r === state.activeRound;
    sel.appendChild(o);
  }
  const i = state.rounds.indexOf(state.activeRound);
  $('#round-prev').disabled = i <= 0;
  $('#round-next').disabled = i < 0 || i >= state.rounds.length - 1;
}

$('#round-select').onchange = (e) => { state.activeRound = e.target.value; renderMatches(); };
$('#round-prev').onclick = () => shiftRound(-1);
$('#round-next').onclick = () => shiftRound(1);
function shiftRound(d) {
  const i = state.rounds.indexOf(state.activeRound) + d;
  if (i >= 0 && i < state.rounds.length) { state.activeRound = state.rounds[i]; renderMatches(); }
}

function renderMatches() {
  renderRoundBar();
  const wrap = $('#days');
  wrap.innerHTML = '';

  const list = state.matches.filter((m) => (m.round_label || 'Maçlar') === state.activeRound);
  if (!list.length) {
    wrap.appendChild(el('div', 'empty', 'Bu tur için henüz maç yok.'));
    return;
  }

  const days = new Map();
  for (const m of list) {
    const k = dayKey(m.utc_date);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(m);
  }

  for (const [, ms] of [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const first = ms[0];
    const day = el('div', 'day');

    const left = humanLeft(new Date(first.lock_at).getTime() - Date.now());
    const lockCls = left ? 'day-lock open' : 'day-lock closed';
    const lockTxt = left ? `Kilide ${left}` : 'Kilitli';

    const head = el('div', 'day-head');
    head.appendChild(el('div', 'day-date', esc(dayLabel(first.utc_date))));
    head.appendChild(el('div', lockCls, lockTxt));
    day.appendChild(head);

    for (const m of ms) day.appendChild(matchCard(m));
    wrap.appendChild(day);
  }
}

function teamRow(name, crest, isWinner) {
  const t = el('div', 'team' + (isWinner ? ' win' : ''));
  if (crest) {
    const img = el('img');
    img.src = crest; img.alt = ''; img.loading = 'lazy';
    t.appendChild(img);
  } else {
    t.appendChild(el('div', '', '<div style="width:22px"></div>'));
  }
  t.appendChild(el('div', 'nm', esc(name)));
  return t;
}

function matchCard(m) {
  const card = el('div', 'match');
  const locked = isLocked(m);
  const fin = isFinished(m);
  const mine = state.myPreds.get(m.id);
  const pts = pointsFor(m, mine);

  // --- üst kısım: takımlar + saat/skor
  const top = el('div', 'match-top');
  const teams = el('div', 'teams');
  teams.appendChild(teamRow(m.home_team, m.home_crest, fin && m.result === '1'));
  teams.appendChild(teamRow(m.away_team, m.away_crest, fin && m.result === '2'));
  top.appendChild(teams);

  const right = el('div', 'kick');
  if (fin || (isLive(m) && m.home_score != null)) {
    right.appendChild(el('div', 'score' + (isLive(m) ? ' live' : ''), `${m.home_score} - ${m.away_score}`));
    right.appendChild(el('div', 's', isLive(m) ? 'Canlı' : 'Bitti'));
  } else {
    right.appendChild(el('div', 't', timeOf(m.utc_date)));
    right.appendChild(el('div', 's', locked ? 'Başladı' : 'TSİ'));
  }
  top.appendChild(right);
  card.appendChild(top);

  // --- 1 / X / 2
  const picks = el('div', 'picks');
  const labels = { '1': 'Ev sahibi', 'X': 'Beraberlik', '2': 'Deplasman' };
  for (const key of ['1', 'X', '2']) {
    const b = el('button', 'pick', `${key}<small>${labels[key]}</small>`);
    if (mine?.pick === key) {
      b.classList.add('on');
      if (fin && m.result) b.classList.add(m.result === key ? 'right' : 'wrong');
    }
    b.disabled = locked;
    b.onclick = () => savePrediction(m, { pick: key });
    picks.appendChild(b);
  }
  card.appendChild(picks);

  // --- skor tahmini (opsiyonel bonus)
  const sr = el('div', 'scorerow');
  const mk = (which) => {
    const i = el('input');
    i.type = 'number'; i.min = '0'; i.max = '20'; i.inputMode = 'numeric';
    i.placeholder = '–';
    i.value = mine?.[which] ?? '';
    i.disabled = locked;
    i.onchange = () => {
      const v = i.value === '' ? null : Math.max(0, Math.min(20, parseInt(i.value, 10)));
      i.value = v ?? '';
      savePrediction(m, { [which]: v });
    };
    return i;
  };
  sr.appendChild(mk('home_score'));
  sr.appendChild(el('span', '', '–'));
  sr.appendChild(mk('away_score'));
  sr.appendChild(el('span', 'lbl', locked ? 'skor tahmini' : 'skor tahmini (opsiyonel, +2 bonus)'));
  if (pts != null) sr.appendChild(el('span', 'pts' + (pts ? '' : ' zero'), `${pts > 0 ? '+' : ''}${pts} puan`));
  card.appendChild(sr);

  // --- kilit açıldıysa: dağılım + kim ne dedi
  if (locked) {
    const all = state.allPreds.get(m.id) || [];
    if (all.length) card.appendChild(revealBlock(m, all));
  }
  return card;
}

function revealBlock(m, all) {
  const box = el('div', 'reveal');
  const n = all.length;
  const c = { '1': 0, 'X': 0, '2': 0 };
  for (const p of all) c[p.pick]++;

  const bar = el('div', 'dist');
  for (const [k, cls] of [['1', 'd1'], ['X', 'dx'], ['2', 'd2']]) {
    const i = el('i', cls);
    i.style.width = `${(c[k] / n) * 100}%`;
    bar.appendChild(i);
  }
  box.appendChild(bar);

  const pct = (k) => Math.round((c[k] / n) * 100);
  box.appendChild(el('div', 'dist-legend',
    `<span>1 · %${pct('1')}</span><span>X · %${pct('X')}</span><span>2 · %${pct('2')}</span>` +
    `<span style="margin-left:auto">${n} tahmin</span>`));

  const list = el('div', 'who-list');
  const order = { '1': 0, 'X': 1, '2': 2 };
  for (const p of [...all].sort((a, b) => order[a.pick] - order[b.pick])) {
    const name = state.profiles.get(p.user_id) || 'Bilinmeyen';
    const score = p.home_score != null && p.away_score != null ? ` ${p.home_score}-${p.away_score}` : '';
    const right = isFinished(m) && m.result === p.pick;
    list.appendChild(el('span', 'chip' + (right ? ' right' : ''), `<b>${esc(name)}</b> ${p.pick}${score}`));
  }
  box.appendChild(list);
  return box;
}

/* ==================================================================== */
/*  Hatırlatma şeridi                                                    */
/* ==================================================================== */
function renderReminder() {
  const box = $('#reminder');
  const open = state.matches.filter((m) => !isLocked(m));
  const missing = open.filter((m) => !state.myPreds.has(m.id));
  if (!missing.length) { box.classList.add('hidden'); return; }

  const soonest = missing.reduce((a, b) =>
    new Date(a.lock_at) < new Date(b.lock_at) ? a : b);
  const left = humanLeft(new Date(soonest.lock_at).getTime() - Date.now());
  const same = missing.filter((m) => m.lock_at === soonest.lock_at).length;

  box.classList.remove('hidden');
  box.innerHTML = `⚠️ <b>${missing.length} maç</b> için tahminin yok. ` +
    `En yakın kilide <b>${left}</b> kaldı (${same} maç).`;
}

/* ==================================================================== */
/*  Tahminlerim                                                          */
/* ==================================================================== */
function renderMine() {
  const v = $('#view-mine');
  v.innerHTML = '';
  const rows = state.matches
    .filter((m) => state.myPreds.has(m.id))
    .sort((a, b) => new Date(b.utc_date) - new Date(a.utc_date));

  if (!rows.length) {
    v.appendChild(el('div', 'empty', 'Henüz tahmin yapmadın. “Maçlar” sekmesinden başla.'));
    return;
  }

  let total = 0, played = 0, correct = 0, exact = 0;
  for (const m of rows) {
    const p = state.myPreds.get(m.id);
    const pts = pointsFor(m, p);
    if (pts != null) {
      total += pts; played++;
      if (p.pick === m.result) correct++;
      if (p.home_score != null && p.home_score === m.home_score && p.away_score === m.away_score) exact++;
    }
  }

  const sum = el('div', 'card');
  sum.appendChild(el('div', 'ttl', 'Toplam'));
  sum.appendChild(el('div', 'val',
    `${total} puan · ${played} maç · ${correct} doğru · ${exact} tam skor`));
  v.appendChild(sum);

  for (const m of rows) {
    const p = state.myPreds.get(m.id);
    const pts = pointsFor(m, p);
    const c = el('div', 'card');
    c.appendChild(el('div', 'ttl',
      `${esc(m.round_label || '')} · ${esc(dayLabel(m.utc_date))} ${timeOf(m.utc_date)}`));
    const score = isFinished(m) ? ` <span style="color:var(--muted)">(${m.home_score}-${m.away_score})</span>` : '';
    c.appendChild(el('div', 'val', `${esc(m.home_team)} — ${esc(m.away_team)}${score}`));
    const myScore = p.home_score != null && p.away_score != null ? ` · skor ${p.home_score}-${p.away_score}` : '';
    const ptsTxt = pts == null ? 'oynanmadı' : `${pts} puan`;
    c.appendChild(el('div', 'ttl',
      `Tahminin: <b style="color:var(--text)">${p.pick}</b>${myScore} → <b style="color:${pts ? 'var(--green)' : 'var(--muted)'}">${ptsTxt}</b>`));
    v.appendChild(c);
  }
}

/* ==================================================================== */
/*  Puan durumu                                                          */
/* ==================================================================== */
async function renderTable() {
  const box = $('#standings');
  box.innerHTML = '<div class="empty">Yükleniyor…</div>';

  const [lb, rl] = await Promise.all([
    sb.from('leaderboard').select('*'),
    sb.from('round_leaderboard').select('*'),
  ]);

  if (lb.error) { box.innerHTML = `<div class="empty">Tablo yüklenemedi: ${esc(lb.error.message)}</div>`; return; }

  const rows = (lb.data || []).sort((a, b) =>
    b.points - a.points || b.correct - a.correct || a.display_name.localeCompare(b.display_name, 'tr'));

  const t = el('table', 'tbl');
  t.innerHTML =
    '<thead><tr><th></th><th>Oyuncu</th><th class="num">O</th><th class="num">D</th>' +
    '<th class="num">Tam</th><th class="num">Puan</th></tr></thead>';
  const tb = el('tbody');
  rows.forEach((r, i) => {
    const tr = el('tr', r.user_id === state.user.id ? 'me' : '');
    tr.innerHTML =
      `<td class="rank ${i < 3 ? 'top' : ''}">${i + 1}</td>` +
      `<td>${esc(r.display_name)}</td>` +
      `<td class="num">${r.played}</td><td class="num">${r.correct}</td>` +
      `<td class="num">${r.exact_scores}</td><td class="num pt">${r.points}</td>`;
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  box.innerHTML = '';
  box.appendChild(t);

  // --- tur şampiyonları
  const rw = $('#round-winners');
  rw.innerHTML = '';
  const byRound = new Map();
  for (const r of rl.data || []) {
    if (!byRound.has(r.round_label)) byRound.set(r.round_label, { start: r.round_start, rows: [] });
    byRound.get(r.round_label).rows.push(r);
  }
  if (!byRound.size) {
    rw.appendChild(el('div', 'empty', 'Henüz tamamlanan tur yok.'));
    return;
  }
  const sorted = [...byRound.entries()].sort((a, b) => new Date(b[1].start) - new Date(a[1].start));
  for (const [label, { rows: rr }] of sorted) {
    const best = Math.max(...rr.map((x) => x.points));
    const winners = rr.filter((x) => x.points === best).map((x) => x.display_name).join(', ');
    const c = el('div', 'card');
    c.appendChild(el('div', 'ttl', esc(label)));
    c.appendChild(el('div', 'val', `🏆 ${esc(winners)} — ${best} puan`));
    rw.appendChild(c);
  }
}

/* ==================================================================== */
/*  Sekmeler                                                             */
/* ==================================================================== */
document.querySelectorAll('.tab').forEach((tb) => {
  tb.onclick = () => {
    state.view = tb.dataset.view;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === tb));
    for (const v of ['matches', 'mine', 'table']) {
      $(`#view-${v}`).classList.toggle('hidden', v !== state.view);
    }
    if (state.view === 'mine') renderMine();
    if (state.view === 'table') renderTable();
  };
});

/* ==================================================================== */
/*  Açılış                                                               */
/* ==================================================================== */
function showAuth() {
  $('#auth').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#boot').classList.add('hidden');
  $('#auth-submit').disabled = false;
}

async function showApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  try {
    await loadAll();
    if (!state.matches.length) {
      $('#days').innerHTML =
        '<div class="empty">Fikstür henüz yüklenmemiş.<br>GitHub’da “Maçları senkronla” akışını bir kez elle çalıştır.</div>';
    } else {
      renderMatches();
    }
    renderReminder();
  } catch (e) {
    toast('Veri yüklenemedi: ' + e.message, true);
  } finally {
    $('#boot').classList.add('hidden');
  }
}

sb.auth.onAuthStateChange((_evt, session) => {
  const user = session?.user || null;
  const changed = user?.id !== state.user?.id;
  state.user = user;
  if (!user) { showAuth(); return; }
  if (changed) showApp();
});

const { data: { session } } = await sb.auth.getSession();
state.user = session?.user || null;
if (state.user) await showApp(); else showAuth();

// Kilit sayaçlarını canlı tut
setInterval(() => {
  if (state.user && state.view === 'matches') { renderMatches(); renderReminder(); }
}, 60000);
