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
