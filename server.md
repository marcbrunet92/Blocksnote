# Architecture — Serveur d'exposition de Blocksnote

## 1. Objectif

Fournir une API HTTP simple, qui encapsule Blocksnote (wrapper PRONOTE) et expose
uniquement ce dont a besoin le futur widget Android : **l'emploi du temps**, sans
que le téléphone n'ait jamais à parler directement le protocole PRONOTE (auth,
chiffrement AES/RSA, parsing des payloads compacts, etc.).

```
┌─────────────────┐        HTTPS (JSON)        ┌──────────────────────┐        Protocole PRONOTE
│  Widget Android  │  ───────────────────────►  │  Serveur (Bun +      │  ───────────────────────►  ┌──────────┐
│ (AppWidget /     │  ◄───────────────────────  │  Blocksnote)         │  ◄───────────────────────  │ PRONOTE  │
│  Glance)         │     GET /timetable          │  - Sessions PRONOTE  │     Instance/Session/       │ (établi- │
└─────────────────┘                              │  - Comptes chiffrés  │     Request                 │ ssement) │
                                                  └──────────────────────┘                              └──────────┘
```

Le serveur est le **seul** composant à dépendre de Blocksnote. Le widget Android
ne consomme qu'une API REST classique, ce qui découple complètement le langage
(Kotlin/Flutter côté client) du TypeScript/Bun côté serveur.

---

## 2. Stack technique proposée

| Composant | Choix | Raison |
|---|---|---|
| Runtime | Bun | déjà utilisé par Blocksnote, pas de couche supplémentaire |
| Librairie métier | Blocksnote (en dépendance locale, non publiée sur npm) | c'est tout l'intérêt du projet |
| Framework HTTP | [Hono](https://hono.dev) *(ou `Bun.serve` natif si on veut zéro dépendance)* | routing propre, middlewares (auth, rate limit) faciles à écrire ; reste très léger |
| Stockage | `bun:sqlite` (intégré à Bun, pas de service externe) | un seul fichier, suffisant pour un usage perso/familial |
| Chiffrement des identifiants stockés | `@noble/ciphers` (déjà une dépendance de Blocksnote) en AES-256-GCM avec une clé maître serveur | éviter une dépendance crypto supplémentaire |
| Reverse proxy / TLS | Caddy (ou Nginx) devant le serveur Bun | HTTPS automatique, simple à maintenir |
| Déploiement | Docker (image `oven/bun`) sur un petit serveur perso / VPS / Raspberry Pi | portable, redémarrage facile |

---

## 3. Modèle de compte et sécurité des identifiants

Le widget ne doit **jamais** connaître le mot de passe PRONOTE en clair après la
configuration initiale, et le serveur ne doit pas non plus le stocker en clair
(il doit cependant le conserver *sous une forme récupérable*, car PRONOTE exige
de rejouer l'authentification quand la session expire — voir §6).

Table `accounts` (SQLite) :

| Colonne | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | identifiant public de compte, donné au client |
| `api_key_hash` | TEXT | hash (SHA-256) de la clé d'API donnée au client à la création |
| `school_url` | TEXT | URL canonique de l'instance (`Instance.cleanUrl`) |
| `role` | TEXT | `student` / `parent` / etc. (mappé sur `NOTSpace`) |
| `encrypted_credentials` | BLOB | `{ username, password }` chiffré AES-256-GCM avec la clé maître serveur |
| `encrypted_session_cache` | BLOB (nullable) | dernière session PRONOTE valide sérialisée, pour éviter de ré-authentifier à chaque appel |
| `session_cached_at` | DATETIME | horodatage du cache de session |
| `created_at` | DATETIME | |

La **clé maître** (`SERVER_SECRET`) vit uniquement dans une variable d'environnement
du serveur, jamais dans la base ni dans le repo.

---

## 4. Cycle de vie d'un compte

### 4.1 Création (une seule fois, depuis l'appli au premier lancement)

```
POST /api/v1/accounts
Body: { "schoolUrl": "...", "username": "...", "password": "...", "role": "student" }
```

Traitement serveur :
1. `Instance.createFromURL(schoolUrl)`
2. `new StudentAuthenticator(instance)` (ou l'Authenticator correspondant au `role`)
3. Renseignement des identifiants sur l'authenticator
4. `authenticator.finalize()` → si succès, on obtient le compte PRONOTE
5. Génération d'une `apiKey` aléatoire (ex. 32 octets), on ne stocke que son hash
6. Chiffrement et stockage des identifiants + de la session obtenue
7. Réponse : `{ "accountId": "...", "apiKey": "...", "fullName": "..." }`

⚠️ L'`apiKey` n'est montrée qu'une seule fois, exactement comme un token d'API
classique. Le widget la stocke localement (`EncryptedSharedPreferences` côté
Android) avec l'`accountId`.

### 4.2 Consultation de l'emploi du temps

```
GET /api/v1/accounts/{accountId}/timetable?from=2026-09-07&to=2026-09-13
Header: Authorization: Bearer <apiKey>
```

Traitement serveur :
1. Vérifie le hash de l'`apiKey` pour cet `accountId`
2. Charge la session en cache (`encrypted_session_cache`) si présente et jugée
   probablement valide
3. Appelle les routes `PageEmploiDuTemps` de Blocksnote avec cette session
4. **Si la session est expirée** (erreur type `SessionExpired` levée par
   Blocksnote) : déchiffre les identifiants stockés, relance tout le flow
   d'authentification (`Instance.createFromURL` → `Authenticator` →
   `finalize()`), met à jour le cache de session, puis réessaie l'appel une fois
5. Transforme la réponse brute PRONOTE (déjà parsée par `Parser`/`DateParser`/
   `NumberSet`) en JSON simple et stable pour le client
6. Renvoie le résultat

### 4.3 Suppression d'un compte

```
DELETE /api/v1/accounts/{accountId}
Header: Authorization: Bearer <apiKey>
```

Supprime la ligne correspondante (identifiants + session en cache).

---

## 5. Contrat d'API — format de réponse de l'emploi du temps

> ⚠️ À valider une fois le contenu réel de `PageEmploiDuTemps/Lesson.ts` et
> `TimeSlot.ts` inspecté — la structure ci-dessous est une proposition de
> mapping stable, pensée pour être simple à consommer côté Android, quelle que
> soit la forme exacte des objets internes de Blocksnote.

```json
{
  "generatedAt": "2026-09-06T08:00:00Z",
  "accountId": "b3f1...",
  "days": [
    {
      "date": "2026-09-07",
      "lessons": [
        {
          "start": "08:00",
          "end": "09:00",
          "subject": "Mathématiques",
          "teacher": "M. Dupont",
          "room": "B204",
          "status": "normal"
        },
        {
          "start": "10:00",
          "end": "11:00",
          "subject": "Anglais",
          "teacher": "Mme Smith",
          "room": "A102",
          "status": "cancelled"
        }
      ]
    }
  ]
}
```

`status` couvre au minimum : `normal`, `cancelled`, `modified` (salle/prof
changés), à ajuster selon ce qu'expose réellement `Lesson.ts`/`Detention.ts`.

---

## 6. Gestion des erreurs PRONOTE

Blocksnote expose déjà des classes d'erreurs dédiées (`structures/errors/`) —
le serveur doit les traduire en codes HTTP explicites plutôt que de les laisser
remonter telles quelles :

| Erreur Blocksnote | Code HTTP renvoyé | Comportement serveur |
|---|---|---|
| `SessionExpired` | *(transparent pour le client)* | ré-authentification automatique + retry, voir §4.2 |
| `AuthenticationError` | `401` | identifiants invalides — le client doit re-proposer la config initiale |
| `DoubleAuthError` | `409` (ou code dédié) | établissement avec double authentification active — cas à gérer manuellement, pas d'automatisation possible côté widget |
| `RateLimitError` | `429` | à propager tel quel, avec un `Retry-After` si possible |
| `NetworkError` / `UnavailableError` | `502` | PRONOTE de l'établissement injoignable |
| `CryptographicError` / `ParsingError` | `500` | bug interne à logger côté serveur |
| `SuspendedError` | `403` | compte PRONOTE suspendu par l'établissement |

---

## 7. Cache et fréquence d'appel à PRONOTE

Pour ne pas solliciter le serveur PRONOTE de l'établissement à chaque
rafraîchissement du widget :

- Cache en mémoire (ou SQLite) du dernier emploi du temps récupéré par compte,
  avec une durée de validité courte (ex. 10–15 min).
- Le widget Android n'a pas besoin d'un temps réel : un `WorkManager` périodique
  toutes les 30–60 minutes (contrainte minimale d'Android pour le travail
  périodique classique) suffit largement pour un emploi du temps.
- Le serveur peut renvoyer un simple `304 Not Modified` (ou un champ
  `unchanged: true`) si rien n'a changé depuis le dernier appel, pour
  économiser de la bande passante côté téléphone.

---

## 8. Sécurité de l'API elle-même

- **Authentification** : `apiKey` par compte (Bearer token), jamais l'identifiant
  PRONOTE directement.
- **Rate limiting** sur `/accounts` (création de compte) pour éviter le
  brute-force sur des identifiants PRONOTE via le serveur — ex. 5 tentatives /
  15 min / IP.
- **HTTPS obligatoire** dès que le serveur est exposé au-delà du réseau local
  (via Caddy/Nginx en frontal).
- **CORS** : pas nécessaire si seul le widget Android consomme l'API (pas
  d'appel depuis un navigateur), sinon le restreindre strictement.
- Ne jamais logger les mots de passe ni les payloads bruts contenant des
  identifiants.

---

## 9. Structure de projet proposée

```
Blocksnote/
├── src/                     # librairie existante (inchangée)
├── server/                  # nouveau package, consomme src/ (ou dist/) en local
│   ├── src/
│   │   ├── index.ts         # bootstrap Hono + routes
│   │   ├── db.ts            # accès bun:sqlite
│   │   ├── crypto.ts        # chiffrement/déchiffrement des identifiants stockés
│   │   ├── pronote-client.ts# fine couche au-dessus de Blocksnote : login, refresh, mapping JSON
│   │   ├── routes/
│   │   │   ├── accounts.ts
│   │   │   └── timetable.ts
│   │   └── middleware/
│   │       ├── auth.ts      # vérification de l'apiKey
│   │       └── rate-limit.ts
│   ├── package.json         # dépend de "blocksnote" en local (workspace ou "file:..")
│   └── Dockerfile
└── (reste du repo inchangé : exemples/, tests/, etc.)
```

Point d'attention : Blocksnote n'est pas publié sur npm (version `0.0.1`,
package privé pour l'instant). Deux options pour que `server/` puisse
l'importer proprement :

1. **Bun workspaces** : transformer le repo en monorepo (`"workspaces": ["server"]`
   dans le `package.json` racine), `server/` dépend de `"blocksnote": "workspace:*"`.
2. **Dépendance locale par chemin** : `"blocksnote": "file:.."` dans
   `server/package.json`, plus simple si on ne veut pas restructurer le repo.

---

## 10. Déploiement

- **Option recommandée pour un usage perso** : petit VPS (ou Raspberry Pi à la
  maison) + Caddy en frontal (HTTPS auto via Let's Encrypt) + conteneur Docker
  pour le serveur Bun.
- Variables d'environnement nécessaires :
  - `SERVER_SECRET` — clé maître de chiffrement des identifiants stockés
  - `PORT`
  - `DB_PATH` — chemin du fichier SQLite
- Redémarrage automatique via `systemd` (service natif) ou `restart: always`
  (Docker Compose).

---

## 11. Côté Android (aperçu, hors périmètre de ce document)

- Un `AppWidgetProvider` (ou `GlanceAppWidget` si Jetpack Compose) affichant les
  cours du jour/de la semaine.
- Un `WorkManager` périodique qui appelle `GET /timetable` et met à jour le
  widget (`RemoteViews`/Glance state).
- Stockage local de l'`accountId` + `apiKey` dans `EncryptedSharedPreferences`.
- Écran de configuration minimal (une fois) : URL établissement + identifiants
  → appelle `POST /accounts` → stocke la réponse.
- Cache local du dernier JSON reçu pour un affichage correct même hors ligne.

---

## 12. Points à vérifier avant d'implémenter

- [ ] Contenu réel de `src/routes/PageEmploiDuTemps/Lesson.ts` et `TimeSlot.ts`
      (champs exacts disponibles : matière, salle, prof, statut annulé/modifié...)
- [ ] Contenu de `Authenticator.ts` (classe de base) : existe-t-il une méthode
      de rafraîchissement de session native, ou faut-il vraiment tout
      rejouer depuis `Instance.createFromURL` à chaque expiration ?
- [ ] Durée de vie réelle d'une session PRONOTE (empirique — à observer)
- [ ] Gestion du cas `DoubleAuthError` (établissements avec double authentification) —
      probablement hors périmètre v1, à documenter comme limitation connue
- [ ] Support multi-compte (un seul élève ou plusieurs profils dans la même
      appli) — impacte le schéma de la table `accounts` et l'écran de config

---

## 13. Roadmap suggérée

1. Squelette serveur (Bun + Hono) + `GET /health`
2. Intégration de Blocksnote en dépendance locale (workspace ou `file:`)
3. `POST /accounts` : flow d'authentification complet + stockage chiffré
4. `GET /accounts/:id/timetable` : appel PRONOTE + mapping JSON stable
5. Gestion des erreurs (tableau §6) + ré-authentification automatique
6. Rate limiting + durcissement sécurité
7. Dockerisation + déploiement
8. (Projet séparé) Widget Android consommant cette API