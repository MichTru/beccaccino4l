create table public.tavoli (
  id text primary key,
  nome text not null,
  stato jsonb not null,
  versione integer not null default 1,
  updated_at timestamptz not null default now()
);
create index tavoli_updated_idx on public.tavoli (updated_at desc);
alter table public.tavoli enable row level security;
create policy "tavoli visibili a tutti" on public.tavoli for select to anon, authenticated using (true);

-- mazzo e chiavi dei giocatori: nessuna policy, li legge solo il server
create table public.segreti (
  tavolo_id text primary key references public.tavoli(id) on delete cascade,
  host text not null,
  posti jsonb not null default '[null,null,null,null]'::jsonb,
  seed bigint
);
alter table public.segreti enable row level security;

create function public.salva_tavolo(p_id text, p_ver integer, p_stato jsonb, p_seed bigint, p_posti jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.tavoli
     set stato = p_stato, versione = versione + 1, updated_at = now()
   where id = p_id and versione = p_ver;
  if not found then
    return false;
  end if;
  update public.segreti
     set seed = coalesce(p_seed, seed), posti = coalesce(p_posti, posti)
   where tavolo_id = p_id;
  return true;
end;
$$;
revoke execute on function public.salva_tavolo(text, integer, jsonb, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.salva_tavolo(text, integer, jsonb, bigint, jsonb) to service_role;

alter publication supabase_realtime add table public.tavoli;
