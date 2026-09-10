-- =====================================================================
--  Okunabilir tahmin görünümü
--  Table Editor'de ham id'ler yerine oyuncu adı ve maç adı görünsün diye.
--  Supabase > SQL Editor > yapıştır > Run. Sonra Table Editor'de
--  "tahminler_okunur" görünümünü açabilirsin.
--
--  Not: Bilerek anon/authenticated rollerine yetki VERİLMİYOR — bu görünüm
--  yalnızca panelden (senin erişimin) görünür, API'den okunamaz. Yani
--  "maç bitmeden tahminler gizli" kuralı bozulmaz.
-- =====================================================================

create or replace view public.tahminler_okunur as
select
  (m.utc_date at time zone 'Europe/Istanbul')::timestamp  as tarih,
  m.round_label                                           as tur,
  m.home_team || ' - ' || m.away_team                     as mac,
  pf.display_name                                         as oyuncu,
  p.pick                                                  as tahmin,
  case when p.home_score is not null
       then p.home_score || '-' || p.away_score end       as skor_tahmini,
  case when m.status = 'FINISHED'
       then m.home_score || '-' || m.away_score end       as sonuc,
  m.result                                                as kazanan,
  case when m.status = 'FINISHED' then
       (case when p.pick = m.result then 3 else 0 end)
     + (case when p.home_score is not null
              and p.home_score = m.home_score
              and p.away_score = m.away_score then 2 else 0 end)
  end                                                     as puan,
  m.status                                                as durum,
  p.match_id,
  p.user_id,
  p.updated_at                                            as guncelleme
from public.predictions p
join public.profiles pf on pf.id = p.user_id
join public.matches  m  on m.id  = p.match_id;

comment on view public.tahminler_okunur is
  'Tahminlerin okunabilir hali: oyuncu adı, maç adı, sonuç ve puan. Sadece panel içindir.';

-- ---------------------------------------------------------------------
--  Tahmin düzeltme yardımcısı
--  UUID aramadan, oyuncu adıyla düzeltme yapmak için.
--    select public.tahmin_duzelt('tonguc', 575336, '1');
--    select public.tahmin_duzelt('tonguc', 575336, '1', 2, 0);   -- skorlu
--  Panelden (postgres rolü) çalıştırılır; RLS'i atlar, yani kilitli
--  maçlarda da çalışır. Bilerek böyle: veri hatası düzeltmek içindir.
-- ---------------------------------------------------------------------
create or replace function public.tahmin_duzelt(
  oyuncu   text,
  mac_id   bigint,
  yeni_pick text,
  ev       int default null,
  dep      int default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid;
  v_mac  text;
  v_eski text;
begin
  if yeni_pick not in ('1', 'X', '2') then
    return 'HATA: tahmin 1, X veya 2 olmalı';
  end if;

  select id into v_uid from public.profiles
   where lower(display_name) = lower(btrim(oyuncu));
  if v_uid is null then
    return 'HATA: "' || oyuncu || '" adında oyuncu yok';
  end if;

  select home_team || ' - ' || away_team into v_mac
    from public.matches where id = mac_id;
  if v_mac is null then
    return 'HATA: ' || mac_id || ' numaralı maç yok';
  end if;

  -- Skor verildiyse 1/X/2 ile tutarlı olmalı.
  if ev is not null and dep is not null then
    if yeni_pick <> (case when ev > dep then '1' when ev = dep then 'X' else '2' end) then
      return 'HATA: ' || ev || '-' || dep || ' skoru "' || yeni_pick || '" tahminiyle çelişiyor';
    end if;
  end if;

  select pick into v_eski from public.predictions
   where user_id = v_uid and match_id = mac_id;

  insert into public.predictions (user_id, match_id, pick, home_score, away_score, updated_at)
  values (v_uid, mac_id, yeni_pick, ev, dep, now())
  on conflict (user_id, match_id) do update
    set pick = excluded.pick,
        home_score = excluded.home_score,
        away_score = excluded.away_score,
        updated_at = now();

  return v_mac || ' — ' || oyuncu || ': '
         || coalesce(v_eski, '(yok)') || ' → ' || yeni_pick
         || coalesce(' (' || ev || '-' || dep || ')', '');
end $$;

revoke all on function public.tahmin_duzelt(text, bigint, text, int, int)
  from public, anon, authenticated;
