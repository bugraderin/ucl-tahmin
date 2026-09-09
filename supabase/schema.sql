-- =====================================================================
--  Şampiyonlar Ligi Tahmin Ligi — Supabase şeması
--  Kurulum: Supabase panelinde SQL Editor > New query > bu dosyayı
--  yapıştır > Run.  (Tamamı tekrar çalıştırılabilir / idempotent.)
-- =====================================================================

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- matches
-- GitHub Actions tarafından football-data.org'dan senkronlanır.
create table if not exists public.matches (
  id          bigint primary key,
  utc_date    timestamptz not null,
  lock_at     timestamptz not null,          -- maçın kendi başlama anı
  stage       text,
  matchday    int,
  round_label text,                          -- "Lig Aşaması - 1. Hafta"
  status      text not null,
  home_team   text not null,
  home_crest  text,
  away_team   text not null,
  away_crest  text,
  home_score  int,
  away_score  int,
  result      text generated always as (
                case
                  when home_score is null or away_score is null then null
                  when home_score > away_score then '1'
                  when home_score = away_score then 'X'
                  else '2'
                end) stored,
  updated_at  timestamptz not null default now()
);

create index if not exists matches_utc_date_idx on public.matches (utc_date);

-- ------------------------------------------------------------ predictions
create table if not exists public.predictions (
  user_id    uuid   not null references auth.users(id) on delete cascade,
  match_id   bigint not null references public.matches(id) on delete cascade,
  pick       text   not null check (pick in ('1','X','2')),
  home_score int    check (home_score between 0 and 20),
  away_score int    check (away_score between 0 and 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, match_id)
);

create index if not exists predictions_match_idx on public.predictions (match_id);

-- Kilit kontrolü. Kilit = maçın kendi başlama saati.
create or replace function public.match_locked(mid bigint)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select lock_at <= now() from public.matches where id = mid), true);
$$;

-- Görünürlük kontrolü. Başkalarının tahminleri maç BİTİNCE açılır
-- (kilit gün başında olur ama tahminler maç sürerken gizli kalır).
create or replace function public.match_finished(mid bigint)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select status = 'FINISHED' from public.matches where id = mid), false);
$$;

-- ------------------------------------------------------------------- RLS
alter table public.profiles    enable row level security;
alter table public.matches     enable row level security;
alter table public.predictions enable row level security;

drop policy if exists "profiller herkese okunur"      on public.profiles;
drop policy if exists "kendi profilini olusturur"     on public.profiles;
drop policy if exists "kendi profilini gunceller"     on public.profiles;
create policy "profiller herkese okunur"  on public.profiles for select to authenticated using (true);
create policy "kendi profilini olusturur" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "kendi profilini gunceller" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "maclar herkese okunur" on public.matches;
create policy "maclar herkese okunur" on public.matches for select to anon, authenticated using (true);

-- Tahminler: kendi tahminini her zaman görürsün; başkalarınınkini yalnızca
-- maç BİTTİKTEN sonra. Yazma ise maç başlayana kadar mümkün.
drop policy if exists "tahminleri gor"    on public.predictions;
drop policy if exists "tahmin ekle"       on public.predictions;
drop policy if exists "tahmin guncelle"   on public.predictions;
drop policy if exists "tahmin sil"        on public.predictions;
create policy "tahminleri gor" on public.predictions for select to authenticated
  using (user_id = auth.uid() or public.match_finished(match_id));
create policy "tahmin ekle" on public.predictions for insert to authenticated
  with check (user_id = auth.uid() and not public.match_locked(match_id));
create policy "tahmin guncelle" on public.predictions for update to authenticated
  using  (user_id = auth.uid() and not public.match_locked(match_id))
  with check (user_id = auth.uid() and not public.match_locked(match_id));
create policy "tahmin sil" on public.predictions for delete to authenticated
  using (user_id = auth.uid() and not public.match_locked(match_id));

-- ------------------------------------------------------- API yetkileri
-- Supabase'de "Automatically expose new tables" kapalı olsa da uygulamanın
-- çalışması için gereken yetkiler burada açıkça veriliyor.
-- Satır bazlı erişimi yukarıdaki RLS kuralları belirler.
grant usage on schema public to anon, authenticated;
grant select                         on public.matches     to anon, authenticated;
grant select, insert, update         on public.profiles    to authenticated;
grant select, insert, update, delete on public.predictions to authenticated;

-- GitHub Actions senkronu service_role anahtarıyla bağlanır.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.matches to service_role;

-- ------------------------------------------------- kayıt olunca profil aç
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
                           split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------- puanlama
--  Doğru 1/X/2  = 3 puan
--  Tam skor     = +2 bonus  (skor yanlışsa ceza yok)
create or replace view public.leaderboard with (security_invoker = off) as
select
  pf.id           as user_id,
  pf.display_name,
  count(*) filter (where m.status = 'FINISHED')                            as played,
  count(*) filter (where m.status = 'FINISHED' and p.pick = m.result)      as correct,
  count(*) filter (where m.status = 'FINISHED'
                     and p.home_score = m.home_score
                     and p.away_score = m.away_score)                      as exact_scores,
  coalesce(sum(
      case when m.status = 'FINISHED' and p.pick = m.result then 3 else 0 end
    + case when m.status = 'FINISHED' and p.home_score is not null
                and p.home_score = m.home_score
                and p.away_score = m.away_score then 2 else 0 end
  ), 0)::int                                                               as points
from public.profiles pf
left join public.predictions p on p.user_id = pf.id
left join public.matches     m on m.id = p.match_id
group by pf.id, pf.display_name;

create or replace view public.round_leaderboard with (security_invoker = off) as
select
  m.round_label,
  min(m.utc_date)  as round_start,
  pf.id            as user_id,
  pf.display_name,
  sum(
      case when p.pick = m.result then 3 else 0 end
    + case when p.home_score is not null
                and p.home_score = m.home_score
                and p.away_score = m.away_score then 2 else 0 end
  )::int as points
from public.predictions p
join public.profiles pf on pf.id = p.user_id
join public.matches  m  on m.id  = p.match_id
where m.status = 'FINISHED'
group by m.round_label, pf.id, pf.display_name;

grant select on public.leaderboard, public.round_leaderboard to anon, authenticated;
