# Serveur GESCOM (licences + synchronisation multi-appareils)

Ce dossier héberge deux fonctions indépendantes du même petit serveur
Node/Express :

- **Licences** (`/api/licences/*`) : génération, révocation, vérification.
  Stockage dans un simple fichier `licences.json`.
- **Synchronisation multi-appareils** (`/api/auth/*`, `/api/devices/*`,
  `/api/sync/*`) : comptes cloud, appareils, synchronisation des données
  entre postes d'une même entreprise. Stockage dans une base PostgreSQL —
  voir la section dédiée plus bas. Facultatif : si `DATABASE_URL` n'est pas
  défini, ces routes répondent une erreur propre mais le serveur de
  licences continue de fonctionner normalement.

## Lancer en local (test)

```
cd server
npm install
ADMIN_TOKEN=choisissez-un-jeton-secret PORT=4000 npm start
```

Ou copiez `.env.example` en `.env` et remplissez les valeurs — le serveur
le charge automatiquement au démarrage.

## Déployer en ligne

Ce serveur tourne sur n'importe quel hébergeur Node classique :
**Render**, **Railway**, **Fly.io**, un VPS avec `pm2`, etc.

1. Déployez le contenu du dossier `server/` (c'est une app Node standard,
   `npm install` puis `npm start`).
2. Définissez la variable d'environnement `ADMIN_TOKEN` sur une valeur
   secrète longue et aléatoire (c'est le mot de passe qui protège la
   création/révocation de licences — ne le partagez qu'avec vous-même).
3. Notez l'URL publique obtenue (ex: `https://gescom-licences.onrender.com`).
4. ⚠️ Sur la plupart des hébergeurs gratuits, le disque n'est **pas
   persistant** entre les redéploiements : `licences.json` serait alors
   réinitialisé. Pour un usage sérieux, montez un disque persistant (Render
   « Persistent Disk », volume Railway, etc.) sur le dossier `server/`.

## Connecter votre application GESCOM

Dans chaque installation de GESCOM (y compris la version `.exe`) :
**Paramètres → Licence → Serveur de validation** → renseignez l'URL du
serveur et le jeton administrateur, puis « Enregistrer ».

Ensuite, dans **Générer une licence pour un client**, chaque clé créée est
enregistrée sur le serveur et peut être révoquée à tout moment depuis la
liste « Licences émises (serveur) ». Le poste du client vérifie sa licence
auprès du serveur à chaque démarrage ; s'il est hors connexion, il retombe
sur la dernière vérification connue pour rester utilisable.

## Limites à connaître (licences)

- Le jeton admin est un secret partagé simple (pas d'OAuth/JWT) — suffisant
  pour un usage interne, à héberger vous-même et à ne jamais exposer côté
  client.
- Le stockage JSON convient à quelques centaines/milliers de licences ; au
  delà, migrez vers une vraie base (SQLite, Postgres).

## Synchronisation multi-appareils (PostgreSQL)

### 1. Provisionner une base

N'importe quel Postgres managé convient (offres gratuites) : [Neon](https://neon.tech),
[Supabase](https://supabase.com), [Railway](https://railway.app). Récupérez
l'URL de connexion (`postgres://user:password@host:5432/dbname`).

### 2. Appliquer le schéma

```
cd server
DATABASE_URL="postgres://..." npm run migrate
```

(ou directement `psql "$DATABASE_URL" -f schema.sql`)

### 3. Configurer et lancer

Dans `.env` (voir `.env.example`) ou vos variables d'environnement d'hébergement :

```
DATABASE_URL=postgres://...
JWT_SECRET=un-secret-long-et-aleatoire-different-du-ADMIN_TOKEN
```

```
npm install
npm start
```

### Routes disponibles

| Route | Auth | Description |
|---|---|---|
| `POST /api/auth/register` | — | Crée l'organisation + premier compte + appareil |
| `POST /api/auth/login` | — | Connexion (email/mot de passe), crée ou réutilise un appareil |
| `POST /api/auth/refresh` | — | Échange un refresh token contre un nouvel access token |
| `GET /api/devices` | Bearer JWT | Liste les appareils de l'organisation |
| `PATCH /api/devices/:id/revoquer` | Bearer JWT | Révoque un appareil (déconnexion forcée) |
| `POST /api/sync/push` | Bearer JWT | Envoie la file locale (`DB.syncQueue`) au serveur |
| `GET /api/sync/pull?since=` | Bearer JWT | Récupère les changements serveur depuis `since` |

Toutes les routes protégées dérivent `organization_id` du token JWT vérifié
côté serveur — jamais d'une valeur envoyée par le client, pour garantir
l'isolation entre entreprises.

### Limites à connaître (synchronisation)

- Résolution de conflit : dernier écrit gagne (par `updated_at`), appliqué
  en SQL de façon atomique (`INSERT ... ON CONFLICT ... WHERE`). Quand un
  envoi est trop ancien face à une version déjà enregistrée, le serveur
  répond `REJECTED_STALE` (pas une erreur) ; le client le trace dans
  `DB.syncConflits` (visible dans Paramètres → Cloud & synchronisation) au
  lieu de croire à tort que son changement est parti. Convient bien aux
  ventes/achats/mouvements de stock de GESCOM, déjà traités comme immuables
  une fois validés côté client — le vrai risque de conflit ne concerne que
  l'édition simultanée d'une même fiche (produit/client/brouillon).
- Formules commerciales (point 17) : chaque organisation a un `plan`
  (`local`/`cloud`/`pro`) qui limite le nombre d'appareils actifs
  simultanément (2 pour `cloud`, 10 pour `pro` — voir
  `LIMITE_APPAREILS_PAR_PLAN` dans `routes/auth.js`). Changer de formule pour
  une organisation : `UPDATE organizations SET plan='pro' WHERE id=...`
  (pas encore d'écran dédié ni de facturation).
- Journal d'audit : `audit_log` trace les inscriptions, connexions (dont les
  échecs), et révocations d'appareil — pas les pushs/pulls de synchro
  (trop volumineux, peu utile pour un audit de sécurité).
- Le rôle `role` de la table `accounts` (owner/member) n'est pas encore
  utilisé pour restreindre quoi que ce soit côté serveur — prévu pour une
  étape ultérieure (permissions avancées au sein d'une même organisation).
- Pas encore de suppression de compte / export RGPD.
