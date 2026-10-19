# Beccaccino

Beccaccino romagnolo online: quattro giocatori, due contro due, mazzo romagnolo da 40 carte.
Si gioca su **michtru.github.io/beccaccino4l** e si può installare nella schermata Home.

**Regole scelte:** cricca (Asso, Due e Tre di briscola = +3), segnali busso / striscio / volo,
si va a 41. Nella prima mano parte chi ha il 4 di Denari.

## Cosa c'è
- Tavoli online con link, QR o codice di 4 caratteri; chi apre il tavolo può aggiungere CPU e chiuderlo.
- Profilo con 12 personaggi delle carte romagnole e codice personale di 6 caratteri per ritrovarsi da un altro telefono.
- "Partite in corso" nel menu per riprendere il posto.
- Se un giocatore non tocca carta per 60 secondi gioca la CPU al posto suo finché non torna.
- Chat rapida con frasi romagnole ed emoji.
- Classifica di tutti i giocatori e storico personale (contano solo le partite finite tra persone).
- Allenamento da solo contro 3 CPU e tutorial guidato con consigli, entrambi anche senza rete.

## File
- `index.html` – la pagina del gioco. Il motore di allenamento e tutorial è una copia di `regole.js`, inserita al montaggio.
- `carte.webp` – il mazzo, 4 righe (Bastoni, Coppe, Denari, Spade) × 10 colonne (Asso…7, Fante, Cavallo, Re).
- `avatar.webp` – i 12 personaggi in fila: Re, Cavallo, Fante di Spade, Coppe, Denari, Bastoni.
- `manifest.webmanifest`, `sw.js`, `icona-*.png` – installazione come app.
- `supabase/functions/beccaccino/` – la funzione sul server: regole, CPU, profili, tempo di gioco, storico.
- `supabase/migrations/` – tabelle del database.

La chiave Supabase nella pagina è quella pubblica: legge solo tavoli e classifica.
Mazzo, chiavi dei giocatori e profili li vede solo il server.
