-- =====================================================================
--  Sohbet — basit grup mesajlaşması
--  Supabase > SQL Editor > yapıştır > Run
-- =====================================================================

create table if not exists public.messages (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  body       text not null check (length(btrim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists messages_created_idx on public.messages (created_at desc);

alter table public.messages enable row level security;

drop policy if exists "mesajlari gor"      on public.messages;
drop policy if exists "mesaj yaz"          on public.messages;
drop policy if exists "kendi mesajini sil" on public.messages;

create policy "mesajlari gor" on public.messages for select to authenticated using (true);
create policy "mesaj yaz"     on public.messages for insert to authenticated
  with check (user_id = auth.uid());
create policy "kendi mesajini sil" on public.messages for delete to authenticated
  using (user_id = auth.uid());

-- Data API yetkileri ("Automatically expose new tables" kapalı olduğu için gerekli).
grant select, insert, delete on public.messages to authenticated;
grant usage, select on sequence public.messages_id_seq to authenticated;

-- Anlık güncelleme: mesajlar yayına eklensin (zaten ekliyse sessizce geç).
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;
