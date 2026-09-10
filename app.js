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

/** localStorage bazı bağlamlarda (gizli sekme, site verisi kapalı) hata atar. */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* önemsiz */ } },
};

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
  days: [],
  activeDay: null,
  fDay: null,      // 'all' | gün anahtarı
  fUser: null,     // 'all' | user_id
  lastSync: null,  // maclarin en son guncellendigi an
  bakiye: 0,       // market puani
  urunler: [],     // market_items
  alimlar: new Set(),   // cifte sans alinan match_id'ler
  view: 'matches',
};

const isLocked = (m) => new Date(m.lock_at).getTime() <= Date.now();
const isFinished = (m) => m.status === 'FINISHED';
const isLive = (m) => ['IN_PLAY', 'PAUSED'].includes(m.status);

/** SQL'deki puan_hesapla ile birebir aynı kural.
 *  Çifte şansta her seçimin kendi skor tahmini vardır. */
function pointsFor(m, p) {
  if (!p || !isFinished(m) || m.result == null) return null;
  const taban = !p.pick2 ? 3 : (p.pick === 'X' || p.pick2 === 'X') ? 3 : 2;

  if (p.pick === m.result) {
    const tam = p.home_score != null && p.home_score === m.home_score
                && p.away_score === m.away_score;
    if (tam) return p.pick2 ? 4 : 5;
    return taban;
  }
  if (p.pick2 && p.pick2 === m.result) {
    const tam2 = p.home_score2 != null && p.home_score2 === m.home_score
                 && p.away_score2 === m.away_score;
    return tam2 ? 4 : taban;
  }
  return 0;
}

const CIFTE = 'cifte_sans';
const urunFiyat = (kod) => state.urunler.find((u) => u.code === kod)?.cost ?? 10;

/* ==================================================================== */
/*  Kimlik doğrulama                                                     */
/* ==================================================================== */
let authMode = 'login';

/** Supabase içeride e-posta istiyor; kullanıcı adından görünmez bir adres üretiyoruz. */
const AUTH_DOMAIN = 'ucl-tahmin.local';
const TR_MAP = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', İ: 'i', I: 'i' };

function userSlug(name) {
  return name.trim().toLowerCase()
    .replace(/[çğıöşüİI]/g, (c) => TR_MAP[c] || c)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}
const slugToEmail = (slug) => `${slug}@${AUTH_DOMAIN}`;

document.querySelectorAll('.seg-btn').forEach((b) => {
  b.onclick = () => {
    authMode = b.dataset.mode;
    document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    $('#f-pass').autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
    $('#auth-submit').textContent = authMode === 'register' ? 'Kayıt ol' : 'Giriş yap';
    $('#auth-msg').textContent = '';
  };
});

$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('#auth-submit');
  const msg = $('#auth-msg');
  const name = $('#f-name').value.trim();
  const password = $('#f-pass').value;
  const slug = userSlug(name);

  btn.disabled = true;
  msg.className = 'auth-msg';
  msg.textContent = 'Bir saniye…';

  try {
    if (slug.length < 2) throw new Error('Kullanıcı adı en az 2 harf olmalı.');
    const email = slugToEmail(slug);

    if (authMode === 'register') {
      const { data, error } = await sb.auth.signUp({
        email, password, options: { data: { display_name: name } },
      });
      if (error) throw error;
      if (!data.session) {
        // e-posta doğrulaması açık kalmışsa buraya düşer
        msg.textContent = 'Kaydın alındı ama oturum açılamadı. Yöneticine haber ver.';
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
  if (s.includes('invalid login')) return 'Kullanıcı adı veya şifre hatalı.';
  if (s.includes('already registered') || s.includes('already exists'))
    return 'Bu kullanıcı adı alınmış, başka bir ad dene.';
  if (s.includes('password')) return 'Şifre en az 6 karakter olmalı.';
  if (s.includes('rate limit')) return 'Çok fazla deneme oldu, biraz bekle.';
  return m;
}

$('#logout').onclick = () => sb.auth.signOut();

/** Üst bardaki market bakiyesi. */
function renderBakiye() {
  const el0 = $('#bakiye');
  if (!el0) return;
  el0.textContent = `🪙 ${state.bakiye}`;
  el0.title = `Market puanın: ${state.bakiye}. Lider tablosu puanın bundan etkilenmez.`;
}

/** Bakiyeyi ve alımları sunucudan tazele. */
async function refreshMarket() {
  const [b, a] = await Promise.all([
    sb.from('market_bakiye').select('bakiye').eq('user_id', state.user.id).maybeSingle(),
    sb.from('purchases').select('match_id, item_code').eq('user_id', state.user.id),
  ]);
  state.bakiye = b.data?.bakiye ?? state.bakiye;
  state.alimlar = new Set((a.data || [])
    .filter((x) => x.item_code === CIFTE).map((x) => x.match_id));
  renderBakiye();
}

async function cifteSansAl(match) {
  const { data, error } = await sb.rpc('market_satin_al',
    { p_item: CIFTE, p_match: match.id });
  if (error) { toast('Alınamadı: ' + error.message, true); return; }
  if (!data?.ok) { toast(data?.hata || 'Alınamadı', true); return; }
  state.alimlar.add(match.id);
  state.bakiye = data.bakiye;
  renderBakiye();
  renderMatches();
  toast(`Çifte şans alındı (−${data.ucret} 🪙). İkinci seçimini işaretle.`);
}

async function cifteSansIade(match) {
  const { data, error } = await sb.rpc('market_iade', { p_item: CIFTE, p_match: match.id });
  if (error) { toast('İade edilemedi: ' + error.message, true); return; }
  if (!data?.ok) { toast(data?.hata || 'İade edilemedi', true); return; }
  state.alimlar.delete(match.id);
  state.bakiye += data.iade;
  const mine = state.myPreds.get(match.id);
  if (mine) { mine.pick2 = null; state.myPreds.set(match.id, mine); }
  renderBakiye();
  renderMatches();
  toast(`İade alındı (+${data.iade} 🪙)`);
}

/* ==================================================================== */
/*  Veri yükleme                                                         */
/* ==================================================================== */
async function loadAll() {
  const [mRes, pRes, prRes, bRes, aRes, iRes] = await Promise.all([
    sb.from('matches').select('*').order('utc_date', { ascending: true }),
    sb.from('predictions').select('user_id, match_id, pick, pick2, home_score, away_score'),
    sb.from('profiles').select('id, display_name'),
    sb.from('market_bakiye').select('bakiye').eq('user_id', state.user.id).maybeSingle(),
    sb.from('purchases').select('match_id, item_code').eq('user_id', state.user.id),
    sb.from('market_items').select('code, name, description, cost').eq('active', true),
  ]);
  if (mRes.error) throw mRes.error;

  state.matches = mRes.data || [];
  state.lastSync = state.matches.reduce(
    (a, m) => (!a || m.updated_at > a ? m.updated_at : a), null);

  state.bakiye = bRes.data?.bakiye ?? 0;
  state.urunler = iRes.data || [];
  state.alimlar = new Set((aRes.data || [])
    .filter((a) => a.item_code === CIFTE).map((a) => a.match_id));

  state.profiles = new Map((prRes.data || []).map((p) => [p.id, p.display_name]));
  state.displayName = state.profiles.get(state.user.id) || (state.user.email || '').split('@')[0];
  $('#me-name').textContent = state.displayName;
  renderBakiye();

  state.myPreds = new Map();
  state.allPreds = new Map();
  for (const p of pRes.data || []) {
    if (p.user_id === state.user.id) state.myPreds.set(p.match_id, p);
    if (!state.allPreds.has(p.match_id)) state.allPreds.set(p.match_id, []);
    state.allPreds.get(p.match_id).push(p);
  }

  // Maçın oynandığı günler, sıralı
  state.days = [...new Set(state.matches.map((m) => dayKey(m.utc_date)))].sort();

  if (!state.activeDay || !state.days.includes(state.activeDay)) {
    const next = state.matches.find((m) => !isLocked(m)) || state.matches[state.matches.length - 1];
    state.activeDay = next ? dayKey(next.utc_date) : state.days[0];
  }
}

/* ==================================================================== */
/*  Tahmin kaydetme                                                      */
/* ==================================================================== */
/** Seçili butona tekrar basınca tahmini tamamen kaldırır. */
async function clearPrediction(match) {
  const prev = state.myPreds.get(match.id);
  state.myPreds.delete(match.id);          // iyimser güncelleme
  renderMatches();

  const { error } = await sb.from('predictions').delete()
    .eq('user_id', state.user.id).eq('match_id', match.id);

  if (error) {
    if (prev) state.myPreds.set(match.id, prev);
    renderMatches();
    toast(error.message.includes('policy')
      ? 'Bu maç kilitlendi, tahmin kaldırılamaz.'
      : 'Kaldırılamadı: ' + error.message, true);
    return;
  }
  toast(`${match.home_team} — ${match.away_team}: tahmin kaldırıldı`);
  renderReminder();
}

async function savePrediction(match, patch) {
  const prev = state.myPreds.get(match.id) || {};
  const next = {
    user_id: state.user.id,
    match_id: match.id,
    pick: patch.pick ?? prev.pick,
    pick2: 'pick2' in patch ? patch.pick2 : (prev.pick2 ?? null),
    home_score:  'home_score'  in patch ? patch.home_score  : (prev.home_score  ?? null),
    away_score:  'away_score'  in patch ? patch.away_score  : (prev.away_score  ?? null),
    home_score2: 'home_score2' in patch ? patch.home_score2 : (prev.home_score2 ?? null),
    away_score2: 'away_score2' in patch ? patch.away_score2 : (prev.away_score2 ?? null),
    updated_at: new Date().toISOString(),
  };
  if (next.pick2 === next.pick) next.pick2 = null;
  if (!next.pick2) { next.home_score2 = null; next.away_score2 = null; }

  const ad = { '1': 'ev sahibi kazanır', X: 'beraberlik', '2': 'deplasman kazanır' };
  const sonucu = (h, a) => (h > a ? '1' : h === a ? 'X' : '2');

  // Her skor, ait olduğu seçimle tutarlı olmak zorunda.
  if (next.home_score != null && next.away_score != null) {
    const d = sonucu(next.home_score, next.away_score);
    if (!next.pick) {
      next.pick = d;                          // henüz seçim yoksa skordan türet
    } else if (next.pick !== d) {
      toast(`“${next.pick}” için girdiğin ${next.home_score}-${next.away_score} skoru ` +
            `“${ad[d]}” demek.`, true);
      renderMatches();
      return;
    }
  }
  if (next.pick2 && next.home_score2 != null && next.away_score2 != null) {
    const d2 = sonucu(next.home_score2, next.away_score2);
    if (next.pick2 !== d2) {
      toast(`“${next.pick2}” için girdiğin ${next.home_score2}-${next.away_score2} skoru ` +
            `“${ad[d2]}” demek.`, true);
      renderMatches();
      return;
    }
  }
  if (!next.pick) return;

  state.myPreds.set(match.id, next);           // iyimser güncelleme
  renderMatches();

  // İkinci skor sütunları yalnızca çifte şans kullanılıyorsa gönderilir;
  // böylece o sütunlar veritabanında yokken normal tahminler bozulmaz.
  const payload = { ...next };
  if (payload.home_score2 == null && payload.away_score2 == null) {
    delete payload.home_score2;
    delete payload.away_score2;
  }

  const { error } = await sb.from('predictions').upsert(payload, { onConflict: 'user_id,match_id' });
  if (error) {
    state.myPreds.set(match.id, prev.pick ? prev : undefined);
    if (!prev.pick) state.myPreds.delete(match.id);
    renderMatches();
    toast(error.message.includes('policy')
      ? 'Bu maç kilitlendi, tahmin değiştirilemez.'
      : 'Kaydedilemedi: ' + error.message, true);
  } else {
    toast(`${match.home_team} — ${match.away_team}: ` +
          `${next.pick2 ? next.pick + '+' + next.pick2 : next.pick} kaydedildi`);
    renderReminder();
  }
}

/* ==================================================================== */
/*  Maçlar görünümü                                                      */
/* ==================================================================== */
function renderDayBar() {
  const sel = $('#round-select');
  sel.innerHTML = '';
  for (const d of state.days) {
    const ms = state.matches.filter((m) => dayKey(m.utc_date) === d);
    const o = el('option');
    o.value = d;
    o.textContent = `${dayLabel(ms[0].utc_date)} · ${ms.length} maç`;
    o.selected = d === state.activeDay;
    sel.appendChild(o);
  }
  const i = state.days.indexOf(state.activeDay);
  $('#round-prev').disabled = i <= 0;
  $('#round-next').disabled = i < 0 || i >= state.days.length - 1;
}

$('#round-select').onchange = (e) => { state.activeDay = e.target.value; renderMatches(); };
$('#round-prev').onclick = () => shiftDay(-1);
$('#round-next').onclick = () => shiftDay(1);
function shiftDay(d) {
  const i = state.days.indexOf(state.activeDay) + d;
  if (i >= 0 && i < state.days.length) { state.activeDay = state.days[i]; renderMatches(); }
}

function renderMatches() {
  renderDayBar();
  const wrap = $('#days');
  wrap.innerHTML = '';

  const list = state.matches.filter((m) => dayKey(m.utc_date) === state.activeDay);
  if (!list.length) {
    wrap.appendChild(el('div', 'empty', 'Bu gün için maç yok.'));
    return;
  }

  const first = list[0];
  const day = el('div', 'day');

  // Kilit artık maç başına; günün bir sonraki kilidini gösteriyoruz.
  const acik = list.filter((m) => !isLocked(m));
  const sonraki = acik.length
    ? acik.reduce((a, b) => (new Date(a.lock_at) < new Date(b.lock_at) ? a : b))
    : null;
  const left = sonraki ? humanLeft(new Date(sonraki.lock_at).getTime() - Date.now()) : null;

  const head = el('div', 'day-head');
  const title = el('div', 'day-date');
  title.innerHTML = `${esc(dayLabel(first.utc_date))}` +
    `<div style="font-size:12px;font-weight:500;color:var(--muted);margin-top:2px">${esc(first.round_label || '')}</div>`;
  head.appendChild(title);
  head.appendChild(el('div', left ? 'day-lock open' : 'day-lock closed',
    left ? `${timeOf(sonraki.lock_at)} · ${left}` : 'Kilitli'));
  day.appendChild(head);

  for (const m of list) day.appendChild(matchCard(m));

  const btn = el('button', 'btn coupon-btn', '🧾 Bu günün kuponunu paylaş');
  btn.onclick = () => shareCoupon(state.activeDay);
  day.appendChild(btn);

  wrap.appendChild(day);
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
  const cifte = state.alimlar.has(m.id);
  const picks = el('div', 'picks');
  const labels = { '1': 'Ev sahibi', 'X': 'Beraberlik', '2': 'Deplasman' };
  for (const key of ['1', 'X', '2']) {
    const secili = mine?.pick === key;
    const ikinci = mine?.pick2 === key;
    const b = el('button', 'pick' + (ikinci ? ' ikinci' : ''), `${key}<small>${labels[key]}</small>`);
    if (secili || ikinci) {
      b.classList.add('on');
      if (fin && m.result) b.classList.add(m.result === key ? 'right' : 'wrong');
    }
    b.disabled = locked;
    if (!locked) {
      if (secili || ikinci) b.title = 'Kaldırmak için tekrar bas';
      else if (cifte && mine?.pick && !mine?.pick2) b.title = 'İkinci seçimin olarak işaretle';
    }
    b.onclick = () => {
      if (secili) {
        // Çifte şansta birinciyi silersen ikincisi birinci olur.
        if (mine?.pick2) savePrediction(m, { pick: mine.pick2, pick2: null });
        else clearPrediction(m);
      } else if (ikinci) {
        savePrediction(m, { pick2: null });
      } else if (cifte && mine?.pick && !mine?.pick2) {
        savePrediction(m, { pick2: key });
      } else {
        savePrediction(m, { pick: key, pick2: null });
      }
    };
    picks.appendChild(b);
  }
  card.appendChild(picks);

  // --- skor tahmini (her seçim için ayrı)
  const skorSatiri = (secim, evAlan, depAlan, etiketli) => {
    const sr = el('div', 'scorerow');
    if (etiketli) sr.appendChild(el('span', 'scoretag', secim));
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
    sr.appendChild(mk(evAlan));
    sr.appendChild(el('span', '', '–'));
    sr.appendChild(mk(depAlan));
    if (!etiketli) {
      sr.appendChild(el('span', 'lbl', locked ? 'skor tahmini'
                                              : 'skor tahmini (opsiyonel, +2 bonus)'));
    } else {
      sr.appendChild(el('span', 'lbl', `${secim} olursa skor`));
    }
    const p2 = etiketli && secim === mine?.pick2
      ? null : (etiketli ? null : pointsFor(m, mine));
    if (p2 != null) sr.appendChild(el('span', 'pts' + (p2 ? '' : ' zero'),
      `${p2 > 0 ? '+' : ''}${p2} puan`));
    return sr;
  };

  if (mine?.pick2) {
    card.appendChild(skorSatiri(mine.pick,  'home_score',  'away_score',  true));
    card.appendChild(skorSatiri(mine.pick2, 'home_score2', 'away_score2', true));
    const pts2 = pointsFor(m, mine);
    if (pts2 != null) {
      card.appendChild(el('div', 'scorerow',
        `<span class="lbl"></span><span class="pts${pts2 ? '' : ' zero'}">` +
        `${pts2 > 0 ? '+' : ''}${pts2} puan</span>`));
    }
  } else {
    card.appendChild(skorSatiri(mine?.pick, 'home_score', 'away_score', false));
  }

  // --- market: çifte şans
  if (!locked) {
    const fiyat = urunFiyat(CIFTE);
    const mr = el('div', 'market-row');
    if (cifte) {
      mr.appendChild(el('span', 'lbl',
        mine?.pick2 ? `Çifte şans: <b style="color:var(--text)">${mine.pick} + ${mine.pick2}</b>`
                    : 'Çifte şans aktif — ikinci seçimini işaretle'));
      const ib = el('button', 'market-btn iade', 'iade al');
      ib.onclick = () => cifteSansIade(m);
      mr.appendChild(ib);
    } else {
      mr.appendChild(el('span', 'lbl', 'İki sonuç birden seç'));
      const ab = el('button', 'market-btn', `Çifte şans · ${fiyat} 🪙`);
      ab.disabled = state.bakiye < fiyat;
      if (ab.disabled) ab.title = `Bakiyen yetmiyor (${state.bakiye} 🪙)`;
      ab.onclick = () => cifteSansAl(m);
      mr.appendChild(ab);
    }
    card.appendChild(mr);
  } else if (mine?.pick2) {
    card.appendChild(el('div', 'market-row',
      `<span class="lbl">Çifte şans: <b style="color:var(--text)">${mine.pick} + ${mine.pick2}</b></span>`));
  }

  // --- maç bittiyse: dağılım + kim ne dedi
  if (fin) {
    const all = state.allPreds.get(m.id) || [];
    if (all.length) card.appendChild(revealBlock(m, all));

  } else if (locked) {
    card.appendChild(el('div', 'reveal',
      '<div class="locked-note">🔒 Herkesin tahmini maç bitince açılacak.</div>'));
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
    const right = isFinished(m) && (m.result === p.pick || (p.pick2 && m.result === p.pick2));
    const secim = p.pick2 ? `${p.pick}+${p.pick2}` : p.pick;
    list.appendChild(el('span', 'chip' + (right ? ' right' : ''), `<b>${esc(name)}</b> ${secim}${score}`));
  }
  box.appendChild(list);
  return box;
}

/* ==================================================================== */
/*  Hatırlatma şeridi                                                    */
/* ==================================================================== */
function renderReminder() {
  const box = $('#reminder');

  // Yalnızca en yakın kilitlenecek gün ilgilendiriyor; sezonun tamamı değil.
  const open = state.matches.filter((m) => !isLocked(m));
  if (!open.length) { box.classList.add('hidden'); return; }

  // Aynı saatte başlayan maçlar birlikte kilitlenir; en yakın gruba bakıyoruz.
  const nextLock = open.reduce((a, b) => (new Date(a.lock_at) < new Date(b.lock_at) ? a : b)).lock_at;
  const grup = open.filter((m) => m.lock_at === nextLock);
  const missing = grup.filter((m) => !state.myPreds.has(m.id));

  if (!missing.length) { box.classList.add('hidden'); return; }

  const left = humanLeft(new Date(nextLock).getTime() - Date.now());
  box.classList.remove('hidden');
  box.innerHTML = `⚠️ <b>${esc(whenLabel(grup[0].utc_date))} ${timeOf(nextLock)}</b> — ` +
    `${grup.length} maçın <b>${missing.length}</b> tanesinde tahminin yok. ` +
    `Kilide <b>${left}</b> kaldı.`;
}

/** "Bugün" / "Yarın" / "12 Eylül Cuma" */
function whenLabel(iso) {
  const k = dayKey(iso);
  const now = Date.now();
  if (k === dayKey(new Date(now).toISOString())) return 'Bugün';
  if (k === dayKey(new Date(now + 864e5).toISOString())) return 'Yarın';
  return dayLabel(iso);
}

/* ==================================================================== */
/*  Tahminler — gün ve kişi filtreli, açılır liste                       */
/* ==================================================================== */
function renderFilters() {
  const dsel = $('#f-day');
  const usel = $('#f-user');

  if (!state.fDay) state.fDay = state.activeDay || 'all';
  if (!state.fUser) state.fUser = state.user.id;

  dsel.innerHTML = '';
  const optAll = el('option'); optAll.value = 'all'; optAll.textContent = 'Tüm günler';
  dsel.appendChild(optAll);
  for (const d of state.days) {
    const ms = state.matches.filter((m) => dayKey(m.utc_date) === d);
    const o = el('option');
    o.value = d;
    o.textContent = `${dayLabel(ms[0].utc_date)} · ${ms.length} maç`;
    dsel.appendChild(o);
  }
  dsel.value = state.days.includes(state.fDay) ? state.fDay : 'all';
  state.fDay = dsel.value;

  usel.innerHTML = '';
  const uAll = el('option'); uAll.value = 'all'; uAll.textContent = 'Herkes';
  usel.appendChild(uAll);
  const people = [...state.profiles.entries()]
    .sort((a, b) => (a[0] === state.user.id ? -1 : b[0] === state.user.id ? 1 : a[1].localeCompare(b[1], 'tr')));
  for (const [id, name] of people) {
    const o = el('option');
    o.value = id;
    o.textContent = id === state.user.id ? `${name} (sen)` : name;
    usel.appendChild(o);
  }
  usel.value = state.profiles.has(state.fUser) ? state.fUser : 'all';
  state.fUser = usel.value;

  dsel.onchange = () => { state.fDay = dsel.value; renderPredictions(); };
  usel.onchange = () => { state.fUser = usel.value; renderPredictions(); };
}

function predRow(p, m, showName) {
  const row = el('div', 'prow');
  const tuttu = m.result === p.pick || (p.pick2 && m.result === p.pick2);
  const right = isFinished(m) && tuttu;
  const wrong = isFinished(m) && m.result && !tuttu;
  row.appendChild(el('div', 'badge' + (right ? ' right' : wrong ? ' wrong' : ''),
    p.pick2 ? `${p.pick}+${p.pick2}` : p.pick));
  row.appendChild(el('div', 'who-nm',
    esc(showName ? (state.profiles.get(p.user_id) || 'Bilinmeyen') +
      (p.user_id === state.user.id ? ' (sen)' : '') : 'Tahminin')));
  row.appendChild(el('div', 'gs',
    p.home_score != null && p.away_score != null ? `${p.home_score}-${p.away_score}` : ''));
  const pts = pointsFor(m, p);
  row.appendChild(el('div', 'pp' + (pts ? '' : ' zero'), pts == null ? '–' : `${pts} p`));
  return row;
}

function renderPredictions() {
  renderFilters();
  const box = $('#pred-list');
  box.innerHTML = '';

  let list = state.matches;
  if (state.fDay !== 'all') list = list.filter((m) => dayKey(m.utc_date) === state.fDay);

  const cards = [];
  for (const m of list) {
    let preds = state.allPreds.get(m.id) || [];
    // Maç bitmeden başkasının tahmini gösterilmez. Sunucu tarafında RLS
    // zaten engelliyor; burada da süzüyoruz ki arayüz hiçbir koşulda
    // (önbellek, ileride kural değişimi) sızdırmasın.
    if (!isFinished(m)) preds = preds.filter((p) => p.user_id === state.user.id);
    if (state.fUser !== 'all') preds = preds.filter((p) => p.user_id === state.fUser);
    if (!preds.length) continue;

    const d = el('details', 'pred');
    if (state.fDay !== 'all') d.open = true;

    const sum = el('summary');
    const fix = el('div', 'fix');
    fix.appendChild(el('div', 'nm', `${esc(m.home_team)} — ${esc(m.away_team)}`));
    fix.appendChild(el('div', 'sub',
      `${esc(dayLabel(m.utc_date))} ${timeOf(m.utc_date)}` +
      (isFinished(m) ? '' : isLocked(m) ? ' · 🔒 gizli' : ' · 🔓 açık') +
      ` · ${preds.length} tahmin`));
    sum.appendChild(fix);

    const meta = el('div', 'meta');
    if (isFinished(m)) meta.appendChild(el('div', 'sc', `${m.home_score}-${m.away_score}`));
    else meta.appendChild(el('div', '', isLive(m) ? 'canlı' : timeOf(m.utc_date)));
    sum.appendChild(meta);
    sum.appendChild(el('div', 'arrow', '›'));
    d.appendChild(sum);

    const body = el('div', 'body');
    if (!isFinished(m)) {
      body.appendChild(el('div', 'locked-note',
        isLocked(m) ? '🔒 Maç bitene kadar yalnızca kendi tahminini görebilirsin.'
                    : '🔒 Tahminler gizli; maç bitince herkesinki açılır.'));
    }
    const order = { '1': 0, X: 1, '2': 2 };
    for (const p of [...preds].sort((a, b) => order[a.pick] - order[b.pick] ||
        (state.profiles.get(a.user_id) || '').localeCompare(state.profiles.get(b.user_id) || '', 'tr'))) {
      body.appendChild(predRow(p, m, state.fUser === 'all'));
    }
    d.appendChild(body);
    cards.push(d);
  }

  if (!cards.length) {
    const who = state.fUser === 'all' ? 'Kimse' :
      state.fUser === state.user.id ? 'Sen' : (state.profiles.get(state.fUser) || 'Bu kişi');
    box.appendChild(el('div', 'empty',
      `${who} bu ${state.fDay === 'all' ? 'sezonda' : 'gün için'} tahmin yapmamış.` +
      (state.fUser !== 'all' && state.fUser !== state.user.id
        ? '<br><span style="font-size:12.5px">Başkalarının tahminleri ancak maç bittikten sonra görünür.</span>' : '')));
    return;
  }

  // Kişi seçiliyse üstte küçük bir özet
  if (state.fUser !== 'all') {
    let total = 0, played = 0, correct = 0, exact = 0;
    for (const m of state.matches) {
      const p = (state.allPreds.get(m.id) || []).find((x) => x.user_id === state.fUser);
      const pts = pointsFor(m, p);
      if (pts == null) continue;
      total += pts; played++;
      if (p.pick === m.result) correct++;
      if (p.home_score != null && p.home_score === m.home_score && p.away_score === m.away_score) exact++;
    }
    const c = el('div', 'card');
    c.appendChild(el('div', 'ttl', esc(state.profiles.get(state.fUser) || '') + ' · sezon toplamı'));
    c.appendChild(el('div', 'val', `${total} puan · ${played} maç · ${correct} doğru · ${exact} tam skor`));
    box.appendChild(c);
  }

  cards.forEach((c) => box.appendChild(c));
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
    for (const v of ['matches', 'preds', 'table']) {
      $(`#view-${v}`).classList.toggle('hidden', v !== state.view);
    }
    if (state.view === 'preds') renderPredictions();
    if (state.view === 'table') renderTable();
  };
});

/* ==================================================================== */
/*  Açılış                                                               */
/* ==================================================================== */
function showAuth() {
  $('#auth').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#chat-fab').classList.add('hidden');     // sohbet #app dışında duruyor
  $('#chat-pop').classList.add('hidden');
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
    renderStamp();
    loadChat().then(subscribeChat);
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

/** Footer'daki "sonuçlar ne zaman güncellendi" satırı. */
function renderStamp() {
  const box = $('#stamp');
  if (!state.lastSync) { box.textContent = ''; return; }
  const age = Date.now() - new Date(state.lastSync).getTime();
  const stale = age > 15 * 60e3;
  box.className = 'stamp' + (stale ? ' stale' : '');
  box.textContent = `Sonuçlar ${timeOf(state.lastSync)}'de güncellendi` +
    (stale ? ` · ${humanLeft(age)} önce, gecikme olabilir` : '');
}

/** Veriyi yeniden çek ve açık olan sekmeyi tazele. */
let refreshing = false;
async function refreshData() {
  if (refreshing) return;
  refreshing = true;
  try {
    await loadAll();
    // Kullanıcı skor kutusuna yazıyorsa ekranı altından çekmeyelim.
    if (document.activeElement?.tagName !== 'INPUT') {
      if (state.view === 'matches') renderMatches();
      if (state.view === 'preds') renderPredictions();
      if (state.view === 'table') renderTable();
    }
    renderReminder();
    renderStamp();
    loadChat().then(subscribeChat);
  } catch (e) {
    console.warn('tazeleme başarısız', e);
  } finally {
    refreshing = false;
  }
}

/** Şu an oynanan ya da yeni başlamış maç var mı? */
function matchWindow() {
  const now = Date.now();
  return state.matches.some((m) => {
    if (isLive(m)) return true;
    if (m.status === 'FINISHED') return false;
    const d = now - new Date(m.utc_date).getTime();
    return d > -20 * 60e3 && d < 3 * 3600e3;
  });
}

// Geri sayımlar dakikada bir tazelenir (veri çekmeden).
setInterval(() => {
  if (!state.user) return;
  if (state.view === 'matches' && document.activeElement?.tagName !== 'INPUT') renderMatches();
  renderReminder();
  renderStamp();
}, 60000);

// Maç saatlerinde 2 dakikada bir, diğer zamanlarda 10 dakikada bir veri çek.
let lastFetch = Date.now();
setInterval(() => {
  if (!state.user || document.hidden) return;
  const gap = matchWindow() ? 2 * 60e3 : 10 * 60e3;
  if (Date.now() - lastFetch < gap) return;
  lastFetch = Date.now();
  refreshData();
}, 30000);

// Sekmeye geri dönüldüğünde beklemeden tazele.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.user && Date.now() - lastFetch > 60e3) {
    lastFetch = Date.now();
    refreshData();
  }
});

/* ==================================================================== */
/*  Kupon — o günün tahminlerini kâğıt fiş görünümünde PNG olarak üretir */
/*  Harici kütüphane yok; her şey canvas üzerinde çiziliyor.            */
/* ==================================================================== */

/** Metni verilen genişliğe sığdır, taşarsa sonuna … koy. */
function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

function couponCanvas(dayK) {
  const list = state.matches
    .filter((m) => dayKey(m.utc_date) === dayK)
    .sort((a, b) => new Date(a.utc_date) - new Date(b.utc_date));
  if (!list.length) return null;

  const S = 2;                        // retina ölçeği
  const W = 760, PAD = 44;
  const rowH = 92, headH = 210, footH = 150;
  const H = headH + list.length * rowH + footH;

  const cv = document.createElement('canvas');
  cv.width = W * S; cv.height = H * S;
  const c = cv.getContext('2d');
  c.scale(S, S);

  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const ink = '#101828', soft = '#667085', line = '#d0d5dd';

  // kâğıt
  c.fillStyle = '#fdfcf8'; c.fillRect(0, 0, W, H);
  c.strokeStyle = line; c.lineWidth = 2;
  c.strokeRect(6, 6, W - 12, H - 12);

  const dashed = (y) => {
    c.save(); c.strokeStyle = line; c.lineWidth = 1.5;
    c.setLineDash([6, 6]); c.beginPath();
    c.moveTo(PAD, y); c.lineTo(W - PAD, y); c.stroke(); c.restore();
  };

  // --- başlık
  c.textAlign = 'center'; c.fillStyle = ink;
  c.font = `700 27px ${MONO}`;
  c.fillText('ŞAMPİYONLAR LİGİ', W / 2, 74);
  c.fillText('TAHMİN LİGİ', W / 2, 106);
  c.font = `15px ${MONO}`; c.fillStyle = soft;
  c.fillText(list[0].round_label || '', W / 2, 134);
  c.font = `700 19px ${MONO}`; c.fillStyle = ink;
  c.fillText(dayLabel(list[0].utc_date).toUpperCase(), W / 2, 164);
  dashed(186);

  c.textAlign = 'left';
  c.font = `16px ${MONO}`; c.fillStyle = soft;
  c.fillText('OYUNCU', PAD, 172 - 0);      // sol üst köşeye ad
  c.textAlign = 'right';
  c.font = `700 17px ${MONO}`; c.fillStyle = ink;
  c.fillText(state.displayName.toUpperCase(), W - PAD, 172);

  // --- satırlar
  let y = headH;
  let toplam = 0, bitmis = 0;
  const adi = { '1': 'EV', X: 'BERABERE', '2': 'DEPLASMAN' };

  for (const m of list) {
    const p = state.myPreds.get(m.id);
    const pts = pointsFor(m, p);
    if (pts != null) { toplam += pts; bitmis++; }

    c.textAlign = 'left'; c.fillStyle = ink; c.font = `600 21px ${MONO}`;
    c.fillText(fitText(c, `${m.home_team} — ${m.away_team}`, W - PAD * 2 - 110), PAD, y);

    c.font = `15px ${MONO}`; c.fillStyle = soft;
    const durum = isFinished(m) ? `BİTTİ  ${m.home_score}-${m.away_score}`
                                : `${timeOf(m.utc_date)} TSİ`;
    c.fillText(durum, PAD, y + 26);

    // seçim kutusu
    const bx = W - PAD - 92, by = y - 26, bw = 92, bh = 56;
    const secim = p?.pick2 ? `${p.pick}+${p.pick2}` : p?.pick;
    c.strokeStyle = secim ? ink : line; c.lineWidth = 2;
    c.strokeRect(bx, by, bw, bh);
    c.textAlign = 'center';
    if (secim) {
      c.fillStyle = ink;
      c.font = `700 ${secim.length > 1 ? 22 : 30}px ${MONO}`;
      c.fillText(secim, bx + bw / 2, by + 37);
      if (p.home_score != null && p.away_score != null) {
        c.font = `14px ${MONO}`; c.fillStyle = soft;
        c.fillText(`${p.home_score}-${p.away_score}`, bx + bw / 2, y + 44);
      }
    } else {
      c.fillStyle = line; c.font = `700 28px ${MONO}`;
      c.fillText('–', bx + bw / 2, by + 38);
    }

    // sonuç işareti
    if (pts != null) {
      c.textAlign = 'right';
      c.font = `700 17px ${MONO}`;
      c.fillStyle = pts > 0 ? '#0a7d55' : '#b42318';
      c.fillText(pts > 0 ? `✓ +${pts}` : '✗ 0', bx - 18, y + 4);
    }

    y += rowH;
    if (m !== list[list.length - 1]) dashed(y - 44);
  }

  // --- alt bilgi
  dashed(y - 34);
  c.textAlign = 'left'; c.font = `16px ${MONO}`; c.fillStyle = soft;
  c.fillText('TOPLAM', PAD, y + 6);
  c.textAlign = 'right'; c.font = `700 24px ${MONO}`; c.fillStyle = ink;
  c.fillText(bitmis ? `${toplam} PUAN` : `${list.length} MAÇ`, W - PAD, y + 8);

  c.textAlign = 'center'; c.font = `14px ${MONO}`; c.fillStyle = soft;
  c.fillText('Doğru 1/X/2 = 3 puan · Tam skor = +2 bonus', W / 2, y + 48);
  c.font = `600 15px ${MONO}`; c.fillStyle = ink;
  c.fillText('bugraderin.github.io/ucl-tahmin', W / 2, y + 78);

  return cv;
}

async function shareCoupon(dayK) {
  const cv = couponCanvas(dayK);
  if (!cv) return;
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  if (!blob) { toast('Kupon oluşturulamadı.', true); return; }

  const ad = `kupon-${dayK}.png`;
  const file = new File([blob], ad, { type: 'image/png' });

  // Telefonda paylaşım menüsü, masaüstünde indirme.
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Tahmin kuponum' });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;   // kullanıcı vazgeçti
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = ad;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Kupon indirildi.');
}

/* ==================================================================== */
/*  Sohbet — yüzen baloncuk, @ ile etiketleme                            */
/* ==================================================================== */
const SEEN_KEY = 'ucl-sohbet-son';
let messages = [];
let chatChannel = null;
let chatOpen = false;

const fMsgTime = new Intl.DateTimeFormat('tr-TR', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit',
});
const fMsgDay = new Intl.DateTimeFormat('tr-TR', {
  timeZone: TZ, day: 'numeric', month: 'long',
});

const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Mesaj gövdesini kaçırıp @isim geçişlerini vurgular. */
function withMentions(text) {
  const html = esc(text);
  const names = [...state.profiles.values()].sort((a, b) => b.length - a.length);
  if (!names.length) return html;
  const re = new RegExp('@(' + names.map((n) => escRe(esc(n))).join('|') + ')', 'g');
  return html.replace(re, (_, nm) =>
    `<span class="mention${nm === esc(state.displayName) ? ' me' : ''}">@${nm}</span>`);
}

const mentionsMe = (m) =>
  state.displayName && m.body.includes('@' + state.displayName);

function unreadList() {
  const seen = store.get(SEEN_KEY) || '';
  return messages.filter((m) => m.created_at > seen && m.user_id !== state.user.id);
}

function renderBadge() {
  const fab = $('#chat-fab');
  const badge = $('#chat-badge');
  fab.classList.toggle('hidden', !state.user);
  const list = chatOpen ? [] : unreadList();
  badge.classList.toggle('hidden', list.length === 0);
  badge.textContent = list.length > 99 ? '99+' : String(list.length);
  fab.title = list.some(mentionsMe) ? 'Seni etiketleyen mesaj var' : 'Sohbet';
}

function renderChat(keepScroll = false) {
  const box = $('#chat-list');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = '';

  if (!messages.length) {
    box.appendChild(el('div', 'empty', 'Henüz mesaj yok.<br>İlk yazan sen ol.'));
    return;
  }

  let lastDay = '';
  for (const m of messages) {
    const day = dayKey(m.created_at);
    if (day !== lastDay) {
      box.appendChild(el('div', 'chat-day', esc(fMsgDay.format(new Date(m.created_at)))));
      lastDay = day;
    }
    const mine = m.user_id === state.user.id;
    const wrap = el('div', 'msg' + (mine ? ' mine' : '') + (mentionsMe(m) ? ' tagged' : ''));
    const who = mine ? 'Sen' : (state.profiles.get(m.user_id) || 'Bilinmeyen');
    const meta = el('div', 'meta', `${esc(who)} · ${fMsgTime.format(new Date(m.created_at))}`);
    if (mine) {
      const del = el('button', 'del', 'sil');
      del.onclick = () => deleteMessage(m.id);
      meta.appendChild(del);
    }
    wrap.appendChild(meta);
    wrap.appendChild(el('div', 'bubble', withMentions(m.body)));
    box.appendChild(wrap);
  }

  if (!keepScroll || atBottom) box.scrollTop = box.scrollHeight;
}

async function loadChat() {
  const { data, error } = await sb.from('messages')
    .select('id, user_id, body, created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) {
    $('#chat-list').innerHTML =
      `<div class="empty">Sohbet yüklenemedi.<br><span style="font-size:12.5px">${esc(error.message)}</span></div>`;
    return;
  }
  messages = (data || []).reverse();
  if (chatOpen) renderChat();
  renderBadge();
}

function markChatSeen() {
  if (messages.length) store.set(SEEN_KEY, messages[messages.length - 1].created_at);
  renderBadge();
}

async function sendMessage(body) {
  const text = body.trim();
  if (!text) return;
  const { error } = await sb.from('messages').insert({ user_id: state.user.id, body: text });
  if (error) toast('Mesaj gönderilemedi: ' + error.message, true);
}

async function deleteMessage(id) {
  const { error } = await sb.from('messages').delete().eq('id', id);
  if (error) { toast('Silinemedi: ' + error.message, true); return; }
  messages = messages.filter((m) => m.id !== id);
  renderChat(true);
}

function subscribeChat() {
  if (chatChannel) return;
  chatChannel = sb.channel('sohbet')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => {
      if (messages.some((m) => m.id === p.new.id)) return;
      messages.push(p.new);
      if (chatOpen) { renderChat(true); markChatSeen(); } else renderBadge();
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (p) => {
      messages = messages.filter((m) => m.id !== p.old.id);
      if (chatOpen) renderChat(true);
    })
    .subscribe();
}

/* ------------------------------------------------------- aç / kapat */
function setChat(open) {
  chatOpen = open;
  $('#chat-pop').classList.toggle('hidden', !open);
  if (open) { renderChat(); markChatSeen(); $('#chat-input').focus(); }
  renderBadge();
}

$('#chat-fab').onclick = () => setChat(!chatOpen);
$('#chat-close').onclick = () => setChat(false);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && chatOpen && $('#mention-box').classList.contains('hidden')) setChat(false);
});

/* --------------------------------------------- @ ile etiketleme */
let mentionMatches = [];
let mentionIx = 0;

/** İmlecin solundaki "@..." parçasını bulur. */
function mentionQuery(input) {
  const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
  const at = upto.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null;   // kelime ortasındaki @ sayılmaz
  const q = upto.slice(at + 1);
  if (/[\n]/.test(q) || q.length > 24) return null;
  return { at, q };
}

function closeMentions() {
  $('#mention-box').classList.add('hidden');
  mentionMatches = [];
}

function renderMentions() {
  const input = $('#chat-input');
  const box = $('#mention-box');
  const mq = mentionQuery(input);
  if (!mq) { closeMentions(); return; }

  const q = mq.q.toLocaleLowerCase('tr');
  mentionMatches = [...state.profiles.values()]
    .filter((n) => n !== state.displayName && n.toLocaleLowerCase('tr').startsWith(q))
    .slice(0, 6);
  if (!mentionMatches.length) { closeMentions(); return; }

  mentionIx = Math.min(mentionIx, mentionMatches.length - 1);
  box.innerHTML = '';
  mentionMatches.forEach((n, i) => {
    const b = el('button', i === mentionIx ? 'on' : '', `@${esc(n)}`);
    b.type = 'button';
    b.onmousedown = (e) => { e.preventDefault(); pickMention(n); };
    box.appendChild(b);
  });
  box.classList.remove('hidden');
}

function pickMention(name) {
  const input = $('#chat-input');
  const mq = mentionQuery(input);
  if (!mq) return;
  const cur = input.selectionStart ?? input.value.length;
  input.value = input.value.slice(0, mq.at) + '@' + name + ' ' + input.value.slice(cur);
  const pos = mq.at + name.length + 2;
  input.setSelectionRange(pos, pos);
  closeMentions();
  input.focus();
}

$('#chat-input').addEventListener('input', () => { mentionIx = 0; renderMentions(); });
$('#chat-input').addEventListener('blur', () => setTimeout(closeMentions, 120));
$('#chat-input').addEventListener('keydown', (e) => {
  if (!mentionMatches.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); mentionIx = (mentionIx + 1) % mentionMatches.length; renderMentions(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); mentionIx = (mentionIx - 1 + mentionMatches.length) % mentionMatches.length; renderMentions(); }
  else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionMatches[mentionIx]); }
  else if (e.key === 'Escape') { e.preventDefault(); closeMentions(); }
});

$('#chat-form').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value;
  input.value = '';
  closeMentions();
  await sendMessage(text);
};
