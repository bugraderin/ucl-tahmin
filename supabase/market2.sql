-- =====================================================================
--  Çifte şansta her seçim için ayrı skor tahmini
--  Örn: 1+2 seçtin; "1 kazanırsa 2-1", "2 kazanırsa 2-5" diyebilirsin.
--  Supabase > SQL Editor > yapıştır > Run.
-- =====================================================================

alter table public.predictions
  add column if not exists home_score2 int check (home_score2 between 0 and 20),
  add column if not exists away_score2 int check (away_score2 between 0 and 20);

-- Eski imza (8 parametreli) bırakılıyor, yenisi 10 parametreli.
drop function if exists public.puan_hesapla(text, text, int, int, text, int, int, text);

create or replace function public.puan_hesapla(
  p_pick text, p_pick2 text,
  p_ev int,  p_dep int,      -- birinci seçimin skor tahmini
  p_ev2 int, p_dep2 int,     -- ikinci seçimin skor tahmini
  m_sonuc text, m_ev int, m_dep int, m_durum text
) returns int
language sql immutable as $$
  select case
    when m_durum <> 'FINISHED' or m_sonuc is null then null

    -- Birinci seçim tuttu
    when p_pick = m_sonuc then
      case
        when p_ev is not null and p_ev = m_ev and p_dep = m_dep
          then case when p_pick2 is null then 5 else 4 end
        when p_pick2 is null then 3
        when p_pick = 'X' or p_pick2 = 'X' then 3
        else 2
      end

    -- İkinci seçim tuttu (yalnızca çifte şansta olur)
    when p_pick2 is not null and p_pick2 = m_sonuc then
      case
        when p_ev2 is not null and p_ev2 = m_ev and p_dep2 = m_dep then 4
        when p_pick = 'X' or p_pick2 = 'X' then 3
        else 2
      end

    else 0
  end;
$$;

-- ------------------------------------------ görünümleri yeni imzaya al
create or replace view public.market_bakiye with (security_invoker = off) as
with kazanc as (
  select p.user_id,
         sum(public.puan_hesapla(p.pick, p.pick2, p.home_score, p.away_score,
                                 p.home_score2, p.away_score2,
                                 m.result, m.home_score, m.away_score, m.status)) as toplam
    from public.predictions p
    join public.matches m on m.id = p.match_id
   group by p.user_id
), harcama as (
  select user_id, sum(cost) as toplam from public.purchases group by user_id
)
select pf.id as user_id, pf.display_name,
       coalesce(k.toplam, 0)::int as kazanilan,
       coalesce(h.toplam, 0)::int as harcanan,
       (coalesce(k.toplam, 0) - coalesce(h.toplam, 0))::int as bakiye
  from public.profiles pf
  left join kazanc  k on k.user_id = pf.id
  left join harcama h on h.user_id = pf.id;

create or replace view public.leaderboard with (security_invoker = off) as
select
  pf.id as user_id,
  pf.display_name,
  count(*) filter (where m.status = 'FINISHED')                                as played,
  count(*) filter (where m.status = 'FINISHED'
                     and (p.pick = m.result or p.pick2 = m.result))            as correct,
  count(*) filter (where m.status = 'FINISHED' and (
       (p.pick  = m.result and p.home_score  = m.home_score and p.away_score  = m.away_score)
    or (p.pick2 = m.result and p.home_score2 = m.home_score and p.away_score2 = m.away_score)
  ))                                                                           as exact_scores,
  coalesce(sum(public.puan_hesapla(p.pick, p.pick2, p.home_score, p.away_score,
                                   p.home_score2, p.away_score2,
                                   m.result, m.home_score, m.away_score, m.status)), 0)::int as points
from public.profiles pf
left join public.predictions p on p.user_id = pf.id
left join public.matches     m on m.id = p.match_id
group by pf.id, pf.display_name;

create or replace view public.round_leaderboard with (security_invoker = off) as
select
  m.round_label,
  min(m.utc_date) as round_start,
  pf.id           as user_id,
  pf.display_name,
  sum(public.puan_hesapla(p.pick, p.pick2, p.home_score, p.away_score,
                          p.home_score2, p.away_score2,
                          m.result, m.home_score, m.away_score, m.status))::int as points
from public.predictions p
join public.profiles pf on pf.id = p.user_id
join public.matches  m  on m.id  = p.match_id
where m.status = 'FINISHED'
group by m.round_label, pf.id, pf.display_name;

grant select on public.leaderboard, public.round_leaderboard to anon, authenticated;
grant select on public.market_bakiye to authenticated;
