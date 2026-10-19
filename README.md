# Beccaccino

Beccaccino romagnolo online per quattro giocatori, due contro due, con mazzo romagnolo da 40 carte.

**Regole scelte:** cricca (Asso, Due e Tre di briscola = +3), segnali busso / striscio / volo, partita a 41.

## Come si gioca
1. Apri la pagina, scrivi il tuo nome e crea un tavolo.
2. Manda il link agli amici con **Copia link**: aprono, scrivono il nome e si siedono.
3. Se manca qualcuno, chi ha aperto il tavolo può aggiungere una CPU.

## Com'è fatto
- `index.html` – la pagina del gioco (GitHub Pages).
- `carte.webp` – il mazzo romagnolo, 4 righe (Bastoni, Coppe, Denari, Spade) × 10 colonne (Asso…7, Fante, Cavallo, Re).
- `supabase/functions/beccaccino/` – la funzione sul server Supabase che applica le regole, distribuisce le carte e fa giocare le CPU. Le mani dei giocatori restano sul server.
- `supabase/migrations/` – tabelle del database.

La chiave Supabase nella pagina è quella pubblica: legge solo i tavoli. Mazzo e chiavi dei giocatori li vede solo il server.
