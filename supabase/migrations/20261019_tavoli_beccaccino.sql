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

-- codice breve per entrare al tavolo (liberato quando il tavolo si chiude)
alter table public.tavoli add column codice text;
create unique index tavoli_codice_key on public.tavoli (codice) where codice is not null;

-- profili dei giocatori: un codice personale per ritrovarsi da un altro telefono
create table public.giocatori (
  id text primary key,
  codice text not null unique,
  nick text not null default '',
  avatar smallint check (avatar between 0 and 11),
  created_at timestamptz not null default now(),
  seen_at timestamptz not null default now()
);
-- una chiave per ogni telefono che usa quel profilo
create table public.chiavi (
  hash text primary key,
  giocatore text not null references public.giocatori(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index chiavi_giocatore_idx on public.chiavi (giocatore);
alter table public.giocatori enable row level security;
alter table public.chiavi enable row level security;

-- una riga per ogni partita finita (le CPU non hanno profilo)
create table public.partite (
  id bigint generated always as identity primary key,
  tavolo text not null,
  finita_at timestamptz not null default now(),
  giocatori jsonb not null,
  punteggi int[] not null,
  vincitori smallint not null,
  mani smallint not null default 0
);
create index partite_giocatori_idx on public.partite using gin (giocatori jsonb_path_ops);
create index partite_finita_idx on public.partite (finita_at desc);
alter table public.partite enable row level security;

-- classifica pubblica: solo nome, personaggio, partite e vittorie
create function public.classifica()
returns table (nick text, avatar smallint, partite int, vittorie int)
language sql stable security definer set search_path = ''
as $$
  select coalesce(nullif(g.nick, ''), 'Giocatore') as nick, g.avatar,
         count(*)::int as partite,
         count(*) filter (where (x->>'team')::int = p.vincitori)::int as vittorie
    from public.partite p
    cross join lateral jsonb_array_elements(p.giocatori) as x
    join public.giocatori g on g.id = x->>'pid'
   group by g.id, g.nick, g.avatar
   order by vittorie desc, partite asc, nick
   limit 50;
$$;
revoke execute on function public.classifica() from public;
grant execute on function public.classifica() to anon, authenticated;
