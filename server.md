# Architecture — Serveur d'exposition de Blocksnote (mono-compte)

## 1. Objectif

Fournir une API HTTP minimale, qui encapsule Blocksnote (wrapper PRONOTE) et
expose une seule chose : **l'emploi du temps d'un unique compte**, configuré
une bonne fois pour toutes côté serveur (pas de gestion multi-utilisateurs, pas
d'écran de configuration côté client). Le widget Android n'a besoin de parler
que HTTP + JSON, jamais le protocole PRONOTE.

```
┌─────────────────┐        HTTPS (JSON)        ┌──────────────────────┐        Protocole PRONOTE
│  Widget Android  │  ───────────────────────►  │  Serveur (Bun +      │  ───────────────────────►  ┌──────────┐
│ (AppWidget /     │  ◄───────────────────────  │  Blocksnote)         │  ◄───────────────────────  │ PRONOTE  │
│  Glance)         │     GET /timetable          │  - 1 session PRONOTE │     Instance/Session/       │ (établi- │
└─────────────────┘                              │  - 1 clé d'API       │     Request                 │ ssement) │
                                                  └──────────────────────┘                              └──────────┘
```

Conséquence directe de la simplification : **pas de base de données, pas de
table de comptes, pas d'endpoint de création/suppression de compte**. Tout est
défini une fois via la configuration du serveur (variables d'environnement).

---

## 2. Stack technique

| Composant | Choix | Raison |
|---|---|---|
| Runtime | Bun | déjà utilisé par Blocksnote |
| Librairie métier | Blocksnote (dépendance locale, non publiée sur npm) | cœur du projet |
| Framework HTTP | [Hono](https://hono.dev) *(ou `Bun.serve` natif, largement suffisant vu le nombre de routes)* | routing + middlewares simples |
| Stockage | **aucun** | un seul compte, identifiants en variables d'environnement, session gardée en mémoire process |
| Reverse proxy / TLS | Caddy (ou Nginx) devant le serveur Bun | HTTPS automatique |
| Déploiement | Docker (image `oven/bun`) sur un petit serveur perso / VPS / Raspberry Pi | portable, redémarrage facile |

Suppression volontaire par rapport à la v1 multi-compte : `bun:sqlite`,
`@noble/ciphers` pour chiffrer des identifiants stockés, table `accounts`. Les
identifiants restent en variables d'environnement (pratique standard, au même
niveau de confiance qu'un `SERVER_SECRET`), il n'y a donc plus rien à chiffrer
côté serveur.

---

## 3. Configuration (variables d'environnement)

| Variable | Exemple | Description |
|---|---|---|
| `PRONOTE_SCHOOL_URL` | `https://demo.index-education.net/pronote/` | URL de l'établissement |
| `PRONOTE_USERNAME` | `jdupont` | identifiant PRONOTE |
| `PRONOTE_PASSWORD` | `********` | mot de passe PRONOTE |
| `PRONOTE_ROLE` | `student` | mappé sur le bon `Authenticator` (`StudentAuthenticator`, etc.) et sur `NOTSpace` |
| `API_KEY` | valeur aléatoire générée une fois (ex. `openssl rand -hex 32`) | protège l'unique endpoint exposé, à copier dans le widget Android |
| `PORT` | `3000` | port d'écoute du serveur |

Ces variables suffisent à démarrer le serveur : pas de fichier de config
additionnel, pas de secret maître à gérer séparément.

---

## 4. Cycle de vie de la session PRONOTE

Le serveur maintient **une seule session en mémoire** (variable module-level,
pas de DB) :

1. **Au démarrage** (ou paresseusement, au premier appel à `/timetable`) :
   - `Instance.createFromURL(PRONOTE_SCHOOL_URL)`
   - `new <Role>Authenticator(instance)` selon `PRONOTE_ROLE`
   - renseignement de `PRONOTE_USERNAME` / `PRONOTE_PASSWORD`
   - `authenticator.finalize()` → session PRONOTE active, gardée en mémoire
2. **À chaque appel** à `/timetable` : réutilisation de la session en mémoire.
3. **Si la session est expirée** (Blocksnote lève `SessionExpired`) : le
   serveur relance automatiquement l'étape 1 avec les mêmes identifiants
   (toujours disponibles en variables d'environnement), puis rejoue l'appel
   une fois.

Pas de notion de "compte" à créer/supprimer : la configuration au démarrage
*est* le compte.

---

## 5. Contrat d'API

Une seule route utile, protégée par la clé d'API statique :

```
GET /api/v1/timetable?from=2026-09-07&to=2026-09-13
Header: Authorization: Bearer <API_KEY>
```

Réponse :

```json
{
  "generatedAt": "2026-09-06T08:00:00Z",
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

> ⚠️ À valider une fois le contenu réel de `PageEmploiDuTemps/Lesson.ts` et
> `TimeSlot.ts` inspecté. `status` couvre au minimum `normal`, `cancelled`,
> `modified`, à ajuster selon ce qu'expose réellement la lib.

Plus, en bonus utile pour le monitoring :

```
GET /api/v1/health   →  200 OK  (pas d'auth requise)
```

---

## 6. Gestion des erreurs PRONOTE

| Erreur Blocksnote | Code HTTP renvoyé | Comportement serveur |
|---|---|---|
| `SessionExpired` | *(transparent pour le client)* | ré-authentification automatique + retry, voir §4 |
| `AuthenticationError` | `500` (loggé en alerte) | identifiants en env devenus invalides — nécessite une intervention manuelle, ce n'est plus un cas "utilisateur" puisqu'il n'y a qu'un seul compte fixe |
| `DoubleAuthError` | `500` (loggé en alerte) | établissement avec double authentification active — non automatisable, limitation connue |
| `RateLimitError` | `429` | à propager tel quel |
| `NetworkError` / `UnavailableError` | `502` | PRONOTE de l'établissement injoignable |
| `CryptographicError` / `ParsingError` | `500` | bug interne à logger |
| `SuspendedError` | `403` | compte PRONOTE suspendu par l'établissement |

---

## 7. Cache

- Cache en mémoire du dernier emploi du temps récupéré, avec une durée de
  validité courte (10–15 min), pour éviter de solliciter PRONOTE à chaque
  appel du widget.
- Le widget Android n'a pas besoin de temps réel : un `WorkManager` périodique
  toutes les 30–60 minutes suffit.

---

## 8. Sécurité de l'API

- Une seule `API_KEY` statique (Bearer token), générée une fois et copiée dans
  le widget Android — pas de rotation prévue en v1, à régénérer manuellement en
  cas de doute (redéploiement avec une nouvelle valeur d'env var).
- **HTTPS obligatoire** dès que le serveur est exposé au-delà du réseau local
  (Caddy/Nginx en frontal).
- Rate limiting léger sur `/timetable` pour éviter tout abus si l'endpoint
  venait à être exposé publiquement.
- Ne jamais logger `PRONOTE_PASSWORD` ni les payloads bruts PRONOTE.

---

## 9. Structure de projet

```
Blocksnote/
├── src/                     # librairie existante (inchangée)
├── server/                  # nouveau package, consomme src/ (ou dist/) en local
│   ├── src/
│   │   ├── index.ts         # bootstrap Hono + routes
│   │   ├── config.ts        # lecture des variables d'environnement
│   │   ├── pronote-session.ts # singleton : login, refresh automatique, mapping JSON
│   │   ├── routes/
│   │   │   ├── timetable.ts
│   │   │   └── health.ts
│   │   └── middleware/
│   │       └── auth.ts      # vérification de l'API_KEY
│   ├── package.json         # dépend de "blocksnote" en local (workspace ou "file:..")
│   └── Dockerfile
└── (reste du repo inchangé : exemples/, tests/, etc.)
```

Blocksnote n'étant pas publié sur npm (`0.0.1`, package privé), deux options
pour l'importer proprement dans `server/` :

1. **Bun workspaces** : monorepo (`"workspaces": ["server"]` dans le
   `package.json` racine), `server/` dépend de `"blocksnote": "workspace:*"`.
2. **Dépendance locale par chemin** : `"blocksnote": "file:.."` dans
   `server/package.json`, plus simple si on ne veut pas restructurer le repo.

---

## 10. Déploiement

- Petit VPS ou Raspberry Pi à la maison + Caddy en frontal (HTTPS auto) +
  conteneur Docker pour le serveur Bun.
- Variables d'environnement à fournir au conteneur : celles du §3.
- Redémarrage automatique via `systemd` ou `restart: always` (Docker Compose).

---

## 11. Côté Android (aperçu, hors périmètre de ce document)

- Un `AppWidgetProvider` (ou `GlanceAppWidget`) affichant les cours du
  jour/de la semaine.
- Un `WorkManager` périodique qui appelle `GET /timetable` avec l'`API_KEY`
  codée en dur (ou dans les ressources de build) et met à jour le widget.
- Pas d'écran de configuration nécessaire côté appli : l'URL du serveur et
  l'`API_KEY` peuvent être fixées à la compilation, vu qu'il n'y a qu'un seul
  compte/serveur à cibler.
- Cache local du dernier JSON reçu pour un affichage correct même hors ligne.

---

## 12. Points à vérifier avant d'implémenter

- [ ] Contenu réel de `src/routes/PageEmploiDuTemps/Lesson.ts` et `TimeSlot.ts`
      (champs exacts disponibles : matière, salle, prof, statut annulé/modifié...)
- [ ] Contenu de `Authenticator.ts` (classe de base) : existe-t-il une méthode
      de rafraîchissement de session native, ou faut-il rejouer tout le flow
      depuis `Instance.createFromURL` à chaque expiration ?
- [ ] Durée de vie réelle d'une session PRONOTE (empirique — à observer)
- [ ] Cas `DoubleAuthError` : à documenter comme limitation connue si le
      compte utilisé a la double authentification activée

---

## 13. Roadmap suggérée

1. Squelette serveur (Bun + Hono) + `GET /health`
2. Intégration de Blocksnote en dépendance locale (workspace ou `file:`)
3. Authentification au démarrage à partir des variables d'environnement
4. `GET /timetable` : appel PRONOTE + mapping JSON stable
5. Ré-authentification automatique sur `SessionExpired` (§4) + gestion des
   autres erreurs (§6)
6. Middleware `API_KEY` + rate limiting léger
7. Dockerisation + déploiement
8. (Projet séparé) Widget Android consommant cette API