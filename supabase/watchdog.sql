-- =====================================================================
--  Bekçi (watchdog) — GitHub'dan bağımsız ikinci güvenlik hattı
--
--  Neden: GitHub Actions'ın zamanlanmış görevleri garantili değil.
--  8 Eylül 2026'da 85 dakika hiç çalışmadı; maçlar IN_PLAY'de dondu ve
--  bitmiş sayılmadıkları için puanlar işlenmedi.
--
--  Ne yapar: 10 dakikada bir sadece KONTROL eder — "maç saati mi ve veri
--  12 dakikadan eski mi?" Öyleyse GitHub'daki senkron akışını tetikler.
--  Veri işleme mantığı tek yerde (scripts/sync-matches.mjs) kalır.
--
--  Kurulum: Supabase > SQL Editor > New query > bu dosyayı yapıştır.
--  ÖNCE aşağıdaki 2. adımdaki TOKEN_BURAYA yazan yeri değiştir.
-- =====================================================================

-- 1) Gerekli eklentiler ------------------------------------------------
--    Hata alırsan: Dashboard > Database > Extensions üzerinden
--    "pg_cron" ve "pg_net" eklentilerini aç, sonra buradan devam et.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) GitHub token'ını Vault'a koy -------------------------------------
--    Aşağıdaki İKİ yerdeki TOKEN_BURAYA'yı kendi token'ınla değiştir.
--    Token: fine-grained, yalnızca bugraderin/ucl-tahmin reposu,
--    tek yetki "Actions: Read and write".
do $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'github_actions_token';
  if v_id is null then
    perform vault.create_secret('TOKEN_BURAYA', 'github_actions_token',
                                'UCL senkron akışını tetikler');
  else
    perform vault.update_secret(v_id, 'TOKEN_BURAYA');
  end if;
end $$;

-- 3) Tetikleme kaydı ---------------------------------------------------
create table if not exists public.watchdog_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  reason     text not null,
  request_id bigint
);
alter table public.watchdog_log enable row level security;  -- API'ye kapalı

-- 4) Bekçi fonksiyonu --------------------------------------------------
create or replace function public.sync_watchdog(force boolean default false)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last   timestamptz;
  v_window boolean;
  v_token  text;
  v_req    bigint;
  v_reason text;
begin
  select max(updated_at) into v_last from public.matches;

  -- Maç penceresi: başlamasına 20 dk kalmış ya da başlayalı 3 saat
  -- olmamış, henüz bitmemiş bir maç var mı?
  select exists (
    select 1 from public.matches
    where status <> 'FINISHED'
      and utc_date < now() + interval '20 minutes'
      and utc_date > now() - interval '3 hours'
  ) into v_window;

  if not force then
    if not v_window then
      return 'maç penceresi dışında, işlem yok';
    end if;
    if v_last > now() - interval '12 minutes' then
      return 'veri taze (' || v_last || '), işlem yok';
    end if;
  end if;

  select decrypted_secret into v_token
    from vault.decrypted_secrets where name = 'github_actions_token';
  if v_token is null then
    return 'HATA: vault içinde github_actions_token yok';
  end if;

  v_reason := case when force then 'elle test'
                   else 'veri bayat, son güncelleme: ' || coalesce(v_last::text, 'yok') end;

  select net.http_post(
    url := 'https://api.github.com/repos/bugraderin/ucl-tahmin/actions/workflows/sync-matches.yml/dispatches',
    body := '{"ref":"main"}'::jsonb,
    headers := jsonb_build_object(
      'Authorization',        'Bearer ' || v_token,
      'Accept',               'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent',           'ucl-tahmin-watchdog',
      'Content-Type',         'application/json'
    )
  ) into v_req;

  insert into public.watchdog_log (reason, request_id) values (v_reason, v_req);
  return 'tetiklendi — ' || v_reason;
end $$;

-- Fonksiyon yalnızca cron/postgres içindir, API'den çağrılamaz.
revoke all on function public.sync_watchdog(boolean) from public, anon, authenticated;

-- 5) Zamanlanmış işler -------------------------------------------------
select cron.unschedule('ucl-watchdog')
 where exists (select 1 from cron.job where jobname = 'ucl-watchdog');
select cron.schedule('ucl-watchdog', '*/10 * * * *', $job$select public.sync_watchdog()$job$);

-- pg_cron ve pg_net kendi kayıt tablolarını sonsuza dek büyütür;
-- günlük temizlik olmazsa veritabanı zamanla yavaşlar.
select cron.unschedule('ucl-temizlik')
 where exists (select 1 from cron.job where jobname = 'ucl-temizlik');
select cron.schedule('ucl-temizlik', '17 4 * * *', $job$
  delete from cron.job_run_details where end_time < now() - interval '3 days';
  delete from net._http_response  where created  < now() - interval '3 days';
  delete from public.watchdog_log where at       < now() - interval '30 days';
$job$);

-- 6) Denetim görünümü --------------------------------------------------
--    Bekçinin ne zaman tetiklediğini ve GitHub'ın ne yanıt verdiğini
--    görmek için:  select * from public.watchdog_durum limit 10;
--    status_code 204 = başarılı. 401/403 = token süresi dolmuş olabilir.
create or replace view public.watchdog_durum as
select l.at, l.reason, r.status_code, r.error_msg
  from public.watchdog_log l
  left join net._http_response r on r.id = l.request_id
 order by l.at desc;
