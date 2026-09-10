-- =====================================================================
--  Market — kazanılan puanla alınan ürünler
--
--  İki ayrı sayaç vardır:
--    * Lider tablosu puanı : hiç azalmaz, sadece kazandıkça artar
--    * Market bakiyesi     : kazanılan toplam puan − harcanan
--
--  Supabase > SQL Editor > yapıştır > Run.
-- =====================================================================

-- ------------------------------------------------------------ ürünler
create table if not exists public.market_items (
  code        text primary key,
  name        text not null,
  description text,
  cost        int  not null check (cost > 0),
  active      boolean not null default true
);

insert into public.market_items (code, name, description, cost) values
  ('cifte_sans', 'Çifte Şans',
   'Bir maçta iki sonuç birden seçersin. 1+X veya X+2 tutarsa 3 puan, 1+2 tutarsa 2 puan. Tam skoru da bilirsen 4 puan.',
   10)
on conflict (code) do update
  set name = excluded.name, description = excluded.description, cost = excluded.cost;

-- --------------------------------------------------------- satın alma
create table if not exists public.purchases (
  id         bigserial primary key,
  user_id    uuid   not null references auth.users(id) on delete cascade,
  item_code  text   not null references public.market_items(code),
  match_id   bigint references public.matches(id) on delete cascade,
  cost       int    not null,                    -- alım anındaki fiyat
  created_at timestamptz not null default now(),
  unique (user_id, item_code, match_id)          -- aynı maça aynı üründen bir tane
);

create index if not exists purchases_user_idx on public.purchases (user_id);

-- ------------------------------------------------- ikinci tahmin alanı
alter table public.predictions
  add column if not exists pick2 text check (pick2 in ('1','X','2'));

-- pick2 varsa pick'ten farklı olmalı
alter table public.predictions drop constraint if exists predictions_pick2_farkli;
alter table public.predictions add constraint predictions_pick2_farkli
  check (pick2 is null or pick2 <> pick);

-- ----------------------------------------------------------- puanlama
--  Tek doğruluk kaynağı: hem görünümler hem uygulama bu kuralı kullanır.
--    Tek tahmin : doğru 3, tam skor +2  →  3 veya 5
--    Çifte şans : X içeren ikili 3, 1+2 ikilisi 2, tam skor varsa 4
create or replace function public.puan_hesapla(
  p_pick text, p_pick2 text, p_ev int, p_dep int,
  m_sonuc text, m_ev int, m_dep int, m_durum text
) returns int
language sql immutable as $$
  select case
    when m_durum <> 'FINISHED' or m_sonuc is null then null
    when p_pick <> m_sonuc and (p_pick2 is null or p_pick2 <> m_sonuc) then 0
    when p_ev is not null and p_ev = m_ev and p_dep = m_dep then
      case when p_pick2 is null then 5 else 4 end
    when p_pick2 is null then 3
    when p_pick = 'X' or p_pick2 = 'X' then 3
    else 2
  end;
$$;

-- --------------------------------------------------- kazanç ve bakiye
create or replace view public.market_bakiye with (security_invoker = off) as
select
  pf.id as user_id,
  pf.display_name,
  coalesce((
    select sum(public.puan_hesapla(p.pick, p.pick2, p.home_score, p.away_score,
                                   m.result, m.home_score, m.away_score, m.status))
      from public.predictions p
      join public.matches m on m.id = p.match_id
     where p.user_id = pf.id
  ), 0)::int as kazanilan,
  coalesce((select sum(cost) from public.purchases q where q.user_id = pf.id), 0)::int as harcanan,
  (coalesce((
    select sum(public.puan_hesapla(p.pick, p.pick2, p.home_score, p.away_score,
                                   m.result, m.home_score, m.away_score, m.status))
      from public.predictions p
      join public.matches m on m.id = p.match_id
     where p.user_id = pf.id
  ), 0)
   - coalesce((select sum(cost) from public.purchases q where q.user_id = pf.id), 0))::int as bakiye
from public.profiles pf;

grant select on public.market_bakiye, public.market_items to authenticated;

-- ------------------------------------------------------------ yetkiler
alter table public.purchases   enable row level security;
alter table public.market_items enable row level security;

drop policy if exists "urunler okunur"   on public.market_items;
drop policy if exists "alimlar okunur"   on public.purchases;
create policy "urunler okunur" on public.market_items for select to authenticated using (true);
create policy "alimlar okunur" on public.purchases   for select to authenticated using (true);

grant select on public.purchases to authenticated;

-- Yazma yalnızca aşağıdaki fonksiyonlar üzerinden; doğrudan insert yok.

-- ------------------------------------------------------ satın alma işlemi
--  Kontroller: ürün etkin mi, maç kilitlenmiş mi, daha önce alınmış mı,
--  bakiye yetiyor mu. Hepsi tek yerde, kullanıcı bunları atlayamaz.
create or replace function public.market_satin_al(p_item text, p_match bigint)
returns json
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_cost   int;
  v_bakiye int;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'hata', 'Giriş yapmalısın');
  end if;

  select cost into v_cost from public.market_items
   where code = p_item and active;
  if v_cost is null then
    return json_build_object('ok', false, 'hata', 'Böyle bir ürün yok');
  end if;

  if public.match_locked(p_match) then
    return json_build_object('ok', false, 'hata', 'Bu maç kilitlendi');
  end if;

  if exists (select 1 from public.purchases
              where user_id = v_uid and item_code = p_item and match_id = p_match) then
    return json_build_object('ok', false, 'hata', 'Bu maça zaten almışsın');
  end if;

  select bakiye into v_bakiye from public.market_bakiye where user_id = v_uid;
  if coalesce(v_bakiye, 0) < v_cost then
    return json_build_object('ok', false, 'hata',
      'Yetersiz bakiye: ' || coalesce(v_bakiye, 0) || ' puanın var, ' || v_cost || ' gerekiyor');
  end if;

  insert into public.purchases (user_id, item_code, match_id, cost)
  values (v_uid, p_item, p_match, v_cost);

  return json_build_object('ok', true, 'bakiye', v_bakiye - v_cost, 'ucret', v_cost);
end $$;

-- --------------------------------------------------------------- iade
--  Maç kilitlenmeden vazgeçilirse ücret geri verilir, ikinci tahmin silinir.
create or replace function public.market_iade(p_item text, p_match bigint)
returns json
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_cost int;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'hata', 'Giriş yapmalısın');
  end if;
  if public.match_locked(p_match) then
    return json_build_object('ok', false, 'hata', 'Maç kilitlendi, iade edilemez');
  end if;

  delete from public.purchases
   where user_id = v_uid and item_code = p_item and match_id = p_match
   returning cost into v_cost;

  if v_cost is null then
    return json_build_object('ok', false, 'hata', 'Böyle bir alım yok');
  end if;

  update public.predictions set pick2 = null, updated_at = now()
   where user_id = v_uid and match_id = p_match;

  return json_build_object('ok', true, 'iade', v_cost);
end $$;

revoke all on function public.market_satin_al(text, bigint) from public, anon;
revoke all on function public.market_iade(text, bigint)     from public, anon;
grant execute on function public.market_satin_al(text, bigint) to authenticated;
grant execute on function public.market_iade(text, bigint)     to authenticated;

-- ------------------------------- ikinci tahmin yalnızca ürün alındıysa
create or replace function public.urun_var(p_uid uuid, p_match bigint, p_item text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.purchases
                  where user_id = p_uid and match_id = p_match and item_code = p_item);
$$;

drop policy if exists "tahmin ekle"     on public.predictions;
drop policy if exists "tahmin guncelle" on public.predictions;
create policy "tahmin ekle" on public.predictions for insert to authenticated
  with check (user_id = auth.uid()
              and not public.match_locked(match_id)
              and (pick2 is null or public.urun_var(auth.uid(), match_id, 'cifte_sans')));
create policy "tahmin guncelle" on public.predictions for update to authenticated
  using  (user_id = auth.uid() and not public.match_locked(match_id))
  with check (user_id = auth.uid()
              and not public.match_locked(match_id)
              and (pick2 is null or public.urun_var(auth.uid(), match_id, 'cifte_sans')));

-- ------------------------------------ puan tablolarını yeni kurala geçir
create or replace view public.leaderboard with (security_invoker = off) as
select
  pf.id as user_id,
  pf.display_name,
  count(*) filter (where m.status = 'FINISHED')                                as played,
  count(*) filter (where m.status = 'FINISHED'
                     and (p.pick = m.result or p.pick2 = m.result))            as correct,
  count(*) filter (where m.status = 'FINISHED'
                     and p.home_score = m.home_score
                     and p.away_score = m.away_score)                          as exact_scores,
  coalesce(sum(public.puan_hesapla(p.pick, p.pick2, p.home_score, p.away_score,
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
                          m.result, m.home_score, m.away_score, m.status))::int as points
from public.predictions p
join public.profiles pf on pf.id = p.user_id
join public.matches  m  on m.id  = p.match_id
where m.status = 'FINISHED'
group by m.round_label, pf.id, pf.display_name;

grant select on public.leaderboard, public.round_leaderboard to anon, authenticated;
