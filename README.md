# ChaTiganu

Aplicație web cu mesagerie directă și panou de administrare pentru ChaTiganu.

## Ce este implementat

- Autentificare prin telefon și parolă, sesiuni în cookie `HttpOnly`, revocare și limitarea încercărilor eșuate.
- Bootstrap repetabil și blocat după prima reușită. Parola inițială se hash-uiește cu Argon2id și trebuie schimbată la prima autentificare.
- Verificare `SUPER_ADMIN` pe server pentru toate rutele `/api/admin/*`.
- Administrare conturi, suspendare/reactivare, impunerea schimbării parolei și revocarea sesiunilor.
- Gestionarea raportărilor și grupurilor, setări generale fără secrete, stare servicii și audit fără date de autentificare.
- Interfață în limba română, adaptată pentru desktop și mobil.
- Mesagerie directă 1-la-1: căutare de conturi active după nume, istoric paginat, evenimente server-sent autentificate, reconectare automată și verificarea periodică a sesiunii. Evenimentele sunt transmise între utilizatori de același proces al serverului.
- Criptare pe dispozitiv cu ECDH P-256, HKDF-SHA-256, AES-256-GCM și semnături ECDSA P-256. API-ul validează semnătura fără să decripteze mesajul.
- Verificarea manuală a amprentei cheilor înainte de citirea sau trimiterea mesajelor; o schimbare a amprentei blochează conversația până la reverificare.

Conturile utilizatorilor se creează deocamdată din panoul SUPER_ADMIN, cu o parolă temporară care trebuie schimbată la prima conectare. Înregistrarea publică și SMS/OTP/email nu sunt conectate; nu sunt simulate verificări.

## Limitele actuale ale chatului

- Sunt implementate conversații directe între două persoane. Grupurile din panoul de administrare sunt încă metadate administrative, nu conversații de grup.
- Cheile private sunt generate în browser și păstrate ca obiecte `CryptoKey` non-extractabile în IndexedDB pe acel dispozitiv. Serverul păstrează numai cheile publice și pachetele criptate.
- Nu există sincronizare între dispozitive sau recuperarea cheilor. Dacă datele browserului sunt șterse ori dispozitivul se pierde, mesajele vechi nu mai pot fi decriptate.
- Protocolul nu oferă forward secrecy: compromiterea ulterioară a unei chei private poate expune mesajele istorice păstrate pentru acea identitate.
- Serverul vede participanții, orele, dimensiunea pachetelor și metadatele sesiunii. Verificarea amprentei printr-un canal separat ajută la detectarea substituției cheilor.
- Acesta este un client web: un hosting sau browser compromis poate servi cod malițios care capturează textul înainte de criptare. Nu este o garanție împotriva compromiterii codului livrat.

## Pornire locală

Necesită Node.js 22.12 sau mai nou.

```sh
npm ci
npm run db:generate
npm run db:push
npm run admin:bootstrap
npm run dev
```

Deschide `http://localhost:5173`. Creează un fișier local `.env` pornind de la `.env.example`; păstrează-l cu permisiuni restrictive și nu îl adăuga în Git. Valorile contului inițial se introduc numai în `.env` sau într-un secret manager. După succesul bootstrap-ului, elimină variabilele `ADMIN_BOOTSTRAP_*` din mediul procesului.

Bootstrap-ul scrie un marcaj unic în baza de date. Rulările ulterioare nu modifică parola sau rolul contului existent și nu au nevoie de variabilele de bootstrap. Dacă numărul este deja folosit de un cont `USER`, comanda se oprește fără să îi schimbe rolul.

## Deploy într-un container cu disc persistent

Proiectul folosește SQLite pentru o instalare cu un singur proces și un volum persistent. Montează un disc persistent la `/app/data`; nu folosi sistemul de fișiere efemer al unui runtime serverless și nu porni mai multe replici pe același fișier SQLite.

În dashboard-ul platformei de hosting, deschide proiectul, serviciul/containerul ChaTiganu și zona **Environment / Variables / Secrets**. Adaugă variabilele permanente:

- `NODE_ENV=production`
- `PORT=3000`
- `APP_ORIGIN=https://domeniul-aplicatiei.example` — originea exactă, fără slash final.
- `DATABASE_URL=file:/app/data/production.db` — calea absolută din volumul montat.
- `LOGIN_THROTTLE_SECRET` — secret aleatoriu de cel puțin 32 de caractere, generat separat.

Pentru inițializare, adaugă temporar și `ADMIN_BOOTSTRAP_NAME`, `ADMIN_BOOTSTRAP_PHONE`, `ADMIN_BOOTSTRAP_PASSWORD` în secretele serviciului. După pornirea containerului, rulează în terminalul serviciului, din `/app`:

```sh
npm run db:push
npm run admin:bootstrap:prod
```

Confirmă mesajul de succes al bootstrap-ului, apoi șterge cele trei variabile `ADMIN_BOOTSTRAP_*` din serviciul de deployment și repornește/redeployează aplicația. Marcajul din baza de date previne reutilizarea comenzii.

> Denumirea exactă a meniului de variabile diferă între furnizori. Dacă alegi un host fără terminal pentru comenzi one-off ori fără volum persistent, configurează mai întâi un job administrativ și o bază de date persistentă compatibilă; acest proiect nu migrează automat datele între SQLite și PostgreSQL.

Pentru trafic cu mai multe replici sau deployment serverless, migrează schema la PostgreSQL înainte de scalare și folosește un mecanism de rate limiting comun tuturor instanțelor.

## Publicare pe VPS la `chatiganu.auto-core.ro`

Repository-ul include `compose.production.yaml` pentru o singură instanță Docker cu SQLite persistentă. VPS-ul răspunde deja prin LiteSpeed pe porturile publice 80/443, așa că aplicația este publicată numai pe `127.0.0.1:3100` și LiteSpeed o proxy-uiește pentru subdomeniul ChaTiganu. Nu opri și nu înlocui LiteSpeed. Pe domeniul `auto-core.ro`, configurează în DNS o înregistrare `A` cu numele `chatiganu` și IPv4-ul public al VPS-ului. Adaugă o înregistrare `AAAA` numai dacă VPS-ul are IPv6 funcțional.

Pe VPS, instalează Docker Engine și pluginul Docker Compose, clonează repository-ul și creează `.env.production` pornind de la `.env.production.example`. Completează `LOGIN_THROTTLE_SECRET` cu un secret aleatoriu de cel puțin 32 de caractere și valorile `ADMIN_BOOTSTRAP_*` cu datele contului inițial. Nu copia `.env` local pe server.

Inițializează baza și contul de administrator, apoi elimină variabilele temporare de bootstrap din `.env.production`:

```sh
docker compose -f compose.production.yaml build app
docker compose -f compose.production.yaml run --rm app npm run db:push
docker compose -f compose.production.yaml run --rm app npm run admin:bootstrap:prod
```

După ce ai eliminat `ADMIN_BOOTSTRAP_NAME`, `ADMIN_BOOTSTRAP_PHONE` și `ADMIN_BOOTSTRAP_PASSWORD`, pornește aplicația:

```sh
docker compose -f compose.production.yaml up -d
docker compose -f compose.production.yaml ps
docker compose -f compose.production.yaml logs --tail=100 app caddy
```

Configurează vhost-ul LiteSpeed pentru `chatiganu.auto-core.ro` să proxy-uiască întregul URI către `http://127.0.0.1:3100`. Poți folosi regulile din [`deploy/litespeed-chatiganu.htaccess`](deploy/litespeed-chatiganu.htaccess) în rădăcina documentului subdomeniului; alternativa este un Web Server external app și un Proxy context în LiteSpeed WebAdmin. Activează certificatul HTTPS al vhost-ului și dezactivează response buffering pentru conexiunile backend, ca evenimentele live SSE să fie livrate imediat. LiteSpeed documentează aceste două metode în [ghidul de proxy cPanel](https://docs.litespeedtech.com/lsws/cp/cpanel/rewrite-proxy/) și [ghidul Node.js](https://docs.litespeedtech.com/lsws/extapp/nodejs/).

Verifică `https://chatiganu.auto-core.ro/api/health`; răspunsul așteptat este `{"status":"ok"}`. Baza este păstrată în volumul Docker `chatigan-production-data`; configurează și verifică periodic copii de siguranță ale acestui volum. Nu porni mai multe replici ale aplicației cu SQLite.

## Securitate și date

- `.env`, bazele SQLite și logurile locale sunt excluse prin `.gitignore`.
- Nu sunt incluse parole inițiale în sursă, exemple de mediu, teste sau migrații.
- Cookie-ul de sesiune este `HttpOnly`, `SameSite=Lax`, `Secure` în producție; tokenul brut nu se stochează în baza de date.
- Cererile mutabile verifică originea și tokenul CSRF. În producție `APP_ORIGIN` este obligatoriu.
- Acțiunile administrative sunt auditate cu metadate. Cererile și parolele nu sunt logate.
- Cheile furnizorilor externi nu sunt returnate de API și nu pot fi editate în panou.
- Contul `SUPER_ADMIN` inițial nu poate fi suspendat sau retrogradat din interfață.
- Nu există rute administrative pentru citirea sau decriptarea mesajelor. Corpurile mesajelor sunt criptate și semnate înainte de trimitere; serverul verifică semnătura și stochează numai pachetul criptat.

## Comenzi

- `npm run dev` — server API și Vite local.
- `npm run build` — generează Prisma Client, compilează serverul și construiește interfața.
- `npm start` — pornește serverul construit.
- `npm test` — testează funcțiile de securitate și fluxul criptografic al mesajelor.
- `npm run check` — verifică tipurile serverului și interfeței.
