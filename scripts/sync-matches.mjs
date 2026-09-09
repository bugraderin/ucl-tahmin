/**
 * football-data.org -> Supabase "matches" senkronu.
 * GitHub Actions tarafından yarım saatte bir çalıştırılır.
 *
 * Gerekli ortam değişkenleri (GitHub repo > Settings > Secrets):
 *   FOOTBALL_DATA_TOKEN         football-data.org ücretsiz API anahtarı
 *   SUPABASE_URL                https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   Supabase > Settings > API > service_role
 */

const TOKEN       = must('FOOTBALL_DATA_TOKEN');
const SB_URL      = must('SUPABASE_URL').replace(/\/+$/, '');
const SB_KEY      = must('SUPABASE_SERVICE_ROLE_KEY');
const COMPETITION = process.env.COMPETITION || 'CL';

function must(name) {
  const v = process.env[name];
  if (!v) { console.error(`Eksik ortam değişkeni: ${name}`); process.exit(1); }
  return v;
}

const STAGE_TR = {
  LEAGUE_STAGE:    (md) => `Lig Aşaması — ${md}. Hafta`,
  GROUP_STAGE:     (md) => `Grup Aşaması — ${md}. Hafta`,
  PLAYOFFS:        () => 'Play-off Turu',
  PLAYOFF_ROUND_1: () => 'Play-off Turu',
  ROUND_OF_16:     () => 'Son 16',
  LAST_16:         () => 'Son 16',
  QUARTER_FINALS:  () => 'Çeyrek Final',
  SEMI_FINALS:     () => 'Yarı Final',
  FINAL:           () => 'Final',
};

function roundLabel(m) {
  const fn = STAGE_TR[m.stage];
  if (fn) return fn(m.matchday);
  return (m.stage || 'Maçlar').replaceAll('_', ' ');
}

async function fetchMatches() {
  const url = `https://api.football-data.org/v4/competitions/${COMPETITION}/matches`;
  const res = await fetch(url, { headers: { 'X-Auth-Token': TOKEN } });
  if (!res.ok) throw new Error(`football-data.org ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.matches || [];
}

function toRows(matches) {
  // Kilit maç başına: tahminler o maçın başlama anında kapanır.
  return matches.map((m) => ({
    id:          m.id,
    utc_date:    m.utcDate,
    lock_at:     m.utcDate,
    stage:       m.stage ?? null,
    matchday:    m.matchday ?? null,
    round_label: roundLabel(m),
    status:      m.status,
    home_team:   m.homeTeam?.shortName || m.homeTeam?.name || 'Belirlenecek',
    home_crest:  m.homeTeam?.crest ?? null,
    away_team:   m.awayTeam?.shortName || m.awayTeam?.name || 'Belirlenecek',
    away_crest:  m.awayTeam?.crest ?? null,
    home_score:  m.score?.fullTime?.home ?? null,
    away_score:  m.score?.fullTime?.away ?? null,
    updated_at:  new Date().toISOString(),
  }));
}

async function upsert(rows) {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const res = await fetch(`${SB_URL}/rest/v1/matches?on_conflict=id`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Maç oynanıyor mu, ya da yakında mı başlıyor? */
function busy(rows) {
  const now = Date.now();
  return rows.some((r) => {
    if (['IN_PLAY', 'PAUSED'].includes(r.status)) return true;
    const t = new Date(r.utc_date).getTime();
    // başlamasına 20 dk kaldıysa ya da başlayalı 3 saat olmadıysa
    return t - now < 20 * 60e3 && now - t < 3 * 3600e3 && r.status !== 'FINISHED';
  });
}

async function syncOnce() {
  const matches = await fetchMatches();
  if (!matches.length) { console.log('API boş liste döndü, işlem yok.'); return null; }
  const rows = toRows(matches);
  await upsert(rows);
  const fin = rows.filter((r) => r.status === 'FINISHED').length;
  const live = rows.filter((r) => ['IN_PLAY', 'PAUSED'].includes(r.status)).length;
  console.log(`${new Date().toISOString().slice(11, 16)} — ${rows.length} maç ` +
              `(${fin} bitmiş, ${live} canlı)`);
  return rows;
}

// WATCH modunda: maç varsa iş bitene kadar takipte kal.
// GitHub'ın zamanlanmış görevleri sık sık gecikiyor/atlanıyor; tek bir
// çalıştırma maç akşamını baştan sona kapatabilsin diye böyle yapıldı.
const WATCH = process.env.WATCH === '1';
const EVERY = Number(process.env.WATCH_INTERVAL_SEC || 180) * 1000;
const UNTIL = Date.now() + Number(process.env.WATCH_MINUTES || 50) * 60e3;

let rows = await syncOnce();
if (WATCH && rows) {
  while (busy(rows) && Date.now() + EVERY < UNTIL) {
    await sleep(EVERY);
    rows = await syncOnce();
    if (!rows) break;
  }
  console.log(busy(rows || []) ? 'Süre doldu, sıradaki çalıştırma devralacak.'
                               : 'Takip edilecek maç kalmadı, çıkılıyor.');
}
