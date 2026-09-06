# Architecture — Serveur d'exposition de Blocksnote (mono-compte)

> **v2** — mis à jour après inspection du code source réel de Blocksnote
> (`src/structures/authentication/`, `src/routes/PageEmploiDuTemps/`,
> `src/structures/errors/`, `src/types/`). Ce document est conçu pour être
> suffisant à lui seul pour implémenter le serveur, sans avoir besoin de
> relire les sources de Blocksnote — sauf pour les quelques points encore
> ouverts listés en §12.

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
| `PRONOTE_ROLE` | `student` | mappé sur le bon `Authenticator` et sur `NOTSpace`, voir tableau ci-dessous |
| `API_KEY` | valeur aléatoire générée une fois (ex. `openssl rand -hex 32`) | protège l'unique endpoint exposé, à copier dans le widget Android |
| `PORT` | `3000` | port d'écoute du serveur |

### Mapping `PRONOTE_ROLE` → classes Blocksnote

Confirmé par inspection de `src/structures/authentication/*.ts` et
`src/types/authentication.ts` :

| `PRONOTE_ROLE` | Classe `Authenticator` | `NOTSpace` (valeur numérique) | Classe `User` retournée par `finalize()` |
|---|---|---|---|
| `student` | `StudentAuthenticator` | `STUDENT` (6) | `Student` |
| `teacher` | `TeacherAuthenticator` | `TEACHER` (8) | `Teacher` |
| `parent` | `ParentAuthenticator` | `PARENT` (7) | `Parent` |
| `company` | `CompanyAuthenticator` | `ENTERPRISE` (39) | `Company` |
| `assistant` | `AssistantAuthenticator` | `ACCOMPANYING` (26) | `Assistant` |
| `administrator` | `AdministratorAuthenticator` | `ADMINISTRATOR` (17) | `Administrator` |
| `schoolLife` | `SchoolLifeAuthenticator` | `SCHOOL_LIFE` (14) | `SchoolLife` |

Chaque `XAuthenticator` sélectionne automatiquement le bon `workspace` dans
`instance.workspaces` en filtrant sur ce `type` — le serveur n'a donc qu'à
choisir la bonne classe `Authenticator` selon `PRONOTE_ROLE`, rien d'autre à
mapper manuellement.

Ces variables suffisent à démarrer le serveur : pas de fichier de config
additionnel, pas de secret maître à gérer séparément.

---

## 4. Cycle de vie de la session PRONOTE

### 4.1 Flux d'authentification réel

Le flux **n'est pas** "configurer les credentials puis appeler `finalize()`"
comme une première version de ce document le supposait. Il y a deux appels
distincts, dont un asynchrone qui fait tout le travail lourd :

```ts
import { Instance } from "blocksnote";
import { StudentAuthenticator } from "blocksnote"; // classe choisie selon PRONOTE_ROLE, cf §3

// 1. Résolution de l'établissement
const instance = await Instance.createFromURL(PRONOTE_SCHOOL_URL);

// 2. Création de l'authenticator (sélectionne automatiquement le bon workspace)
const authenticator = new StudentAuthenticator(instance);

// 3. Échange complet : crée la Session, charge les Settings, résout le Challenge,
//    envoie "Authentification" à PRONOTE, échange la clé AES. Tout est fait ici.
await authenticator.credentials(PRONOTE_USERNAME, PRONOTE_PASSWORD);

// 4. Vérification double authentification AVANT finalize() — voir §4.2, point critique
const security = authenticator.security;
if (security.mustEnterPIN || security.mustChangePassword) {
  // Pas automatisable avec juste username/password en env — traiter comme erreur
  // de configuration serveur (log alerte, ne pas retenter en boucle).
  throw new Error("Double authentification active sur ce compte PRONOTE — non gérable en mode serveur automatisé");
}

// 5. Finalisation : appelle en interne validate() → security.execute() (no-op si
//    aucun mot de passe/pin fourni, cf §4.2) puis charge l'objet User
const user = await authenticator.finalize(); // -> Student (ou Teacher, Parent, etc.)
```

`user.session` est l'objet à garder en mémoire process (singleton du
serveur) : c'est lui qui porte la clé AES active et le `RequestManager` utilisé
pour toutes les requêtes suivantes (dont le rechargement de l'emploi du temps).

### 4.2 ⚠️ Point critique : la double authentification n'est PAS automatiquement bloquante

`AccountSecurity.execute()` (appelée en interne par `finalize()` via
`validate()`) contient ce garde-fou :

```ts
public async execute(): Promise<this> {
  if ((this._device && !this._pin && !this._mode) || !this._password) return this;
  // ... sinon envoie une requête "SecurisationCompteDoubleAuth"
}
```

Tant que le serveur n'appelle jamais explicitement `.password()`, `.pin()` ou
`.register()` sur `authenticator.security`, `_password` reste `undefined` et
la méthode **retourne silencieusement sans rien envoyer, sans lever
d'exception**. Autrement dit : `finalize()` peut réussir "normalement" même
si le compte a la double authentification activée côté établissement.

Conséquence pour l'implémentation :
- Il faut **vérifier explicitement** `authenticator.security.mustEnterPIN` et
  `authenticator.security.mustChangePassword` juste après `credentials()`,
  avant d'appeler `finalize()` (code ci-dessus).
- **Point ouvert** (voir §12) : on n'a pas identifié dans le code inspecté
  l'endroit exact où `DoubleAuthError` (classe définie dans
  `src/structures/errors/DoubleAuthError.ts`, jamais vue instanciée) est
  effectivement levée. Il est possible qu'elle soit levée plus loin, lors
  d'un appel `PageEmploiDuTemps` qui échouerait silencieusement côté PRONOTE
  si la double auth n'a pas été validée. À tester empiriquement avec le
  compte réel, ou à vérifier en lisant `Request.ts` / `RequestManager.ts`
  (non inspectés).
- Recommandation pratique : **utiliser un compte PRONOTE sans double
  authentification activée** pour ce serveur, pour éviter ce cas limite non
  automatisable de toute façon (pas d'interaction humaine possible côté
  serveur).

### 4.3 Réutilisation et expiration de la session

1. **Au démarrage** (ou paresseusement, au premier appel à `/timetable`) :
   flux complet du §4.1.
2. **À chaque appel** à `/timetable` : réutilisation de `user.session` en
   mémoire (variable module-level, singleton).
3. **Si la session est expirée** : Blocksnote lève `SessionExpiredError`
   (nom réel de la classe, différent de ce qui avait été supposé en v1 — voir
   §6 pour le détail des classes d'erreur réelles). Le serveur relance
   automatiquement le flux du §4.1 avec les mêmes identifiants (toujours
   disponibles en variables d'environnement), puis rejoue l'appel **une
   seule fois** (pas de retry récursif, pour éviter une boucle infinie si le
   nouveau login échoue aussi pour une autre raison).

Pas de notion de "compte" à créer/supprimer : la configuration au démarrage
*est* le compte.

---

## 5. Récupération de l'emploi du temps

### 5.1 API interne Blocksnote

`Timetable.load()` (dans `src/routes/PageEmploiDuTemps/Common.ts`) a la
signature suivante :

```ts
static async load(
  user: User,
  ressource: Ressource[] | Ressource,
  options: TimetableOptions
): Promise<Timetable>
```

`User` (classe de base, dans `src/structures/users/User.ts`) expose une
méthode **protégée** `_timetable()` qui calcule le paramètre `ressource` et
fournit une valeur par défaut pratique pour `from`/`to` :

```ts
protected _timetable(
  target: Class | StudentUserSettings | TeacherUserSettings | Class[],
  options?: TimetableOptions
): Promise<Timetable> {
  const res = Array.isArray(target)
    ? target.map((t) => ({ G: t.kind, N: t.id }))
    : { G: target.kind, N: target.id };

  if (!options?.from || !options?.to) {
    // Calcule automatiquement la semaine civile courante (lundi → dimanche)
    const d = new Date();
    const day = d.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    const from = new Date(d); from.setDate(d.getDate() + diff);
    const to = new Date(from); to.setDate(from.getDate() + 6);
    options = { ...options, from, to };
  }
  return Timetable.load(this, res, options);
}
```

Points utiles pour le serveur :
- **`from`/`to` sont des objets `Date` JS**, pas des strings — le serveur doit
  parser les query params `?from=2026-09-07&to=2026-09-13` en `Date` avant
  d'appeler la méthode de timetable.
- Si `from`/`to` ne sont **pas** fournis par le widget, on peut simplement ne
  pas les passer : la lib calcule elle-même la semaine civile courante. Pas
  besoin de dupliquer cette logique côté serveur.
- **Point ouvert** (voir §12) : `_timetable()` est `protected`, donc appelée
  en interne par une méthode publique de `Student` (ou `Teacher`, etc.) qu'on
  n'a pas encore inspectée (`src/structures/users/Student.ts`). Il faut lire
  ce fichier pour connaître le nom exact de la méthode publique à appeler
  côté serveur (probablement quelque chose comme `student.timetable(options)`
  qui appelle en interne `this._timetable(this.user, options)`, mais à
  confirmer — ne pas deviner l'implémentation).

### 5.2 Types de réponse PRONOTE (confirmés)

```ts
// src/types/responses/timetable.ts
type CommunPageEmploiDuTempsResponse = {
  ListeCours: PronoteCourse[];
  absences?: { joursCycle: JourAbsence[] };
}

type PronoteCourse = {
  estRetenue?: string;        // présence de ce champ → c'est une "Detention"
  AvecCdT: boolean;
  AvecTafPublie: boolean;
  CouleurFond: string;
  DateDuCours: Date;
  duree: number;
  place: number;
  ListeContenus: PronoteContent[];
  Statut?: string;            // valeurs possibles non observées empiriquement
  estAnnule?: boolean;
  cahierDeTextes?: { estEval: boolean } & PronoteLabel;
  listeVisios?: PronoteVisio[];
  hintRealise?: string;
}
```

`Timetable.lessons` transforme chaque `PronoteCourse` en `Lesson` (cours
normal) ou `Detention` (retenue) selon la présence de `estRetenue` :

```ts
// src/routes/PageEmploiDuTemps/Common.ts
private static addTimeSlot(course, timetable, settings): TimeSlot {
  if (course.estRetenue) return new Detention(course, timetable, settings);
  return new Lesson(course, timetable, settings);
}
```

`Timetable.days` groupe ensuite les créneaux par date civile (attention :
malgré le typage `Lesson[] | Detention[]` du type `TimetableDay`, en pratique
le tableau `lessons` d'un jour peut mélanger les deux types — c'est un
tableau hétérogène, il faut le gérer comme tel côté mapping JSON).

### 5.3 Champs exposés par créneau (`TimeSlot`, `Lesson`, `Detention`)

```
TimeSlot (base commune)
├── from: Date                (raw.DateDuCours)
├── to: Date                  (from + duration)
├── duration: number          (ms — calculé depuis raw.duree et settings.schedule.seatsPerHour)
├── rooms: string[]           (content type 17 — PLURIEL, un créneau peut avoir plusieurs salles)
├── staffs: string[]          (content type 34 — distinct de "teachers")
└── excluded: boolean         (créneau dans une plage exclue par une absence d'établissement)

Lesson extends TimeSlot
├── subject: string | string[] | undefined   (content type 16, ⚠ type incohérent dans la lib — toujours un tableau en pratique via content(), donc probablement toujours string[] ou undefined malgré le typage)
├── teachers: string[]        (content type 3 — PLURIEL, co-enseignement possible)
├── groups: string[]          (content type 2)
├── canceled: boolean         (raw.estAnnule — booléen fiable, pas besoin de parser un statut texte)
├── status: string | undefined  (raw.Statut — texte brut PRONOTE, ex. "Modifié" à confirmer empiriquement)
├── evaluation: boolean       (raw.cahierDeTextes?.estEval — contrôle/devoir noté)
├── backgroundColor: string   (raw.CouleurFond, format hex probable)
└── videoconference: Videoconference[]
      { comment?: string; label?: string; url: URL }

Detention extends TimeSlot
└── state: string             (raw.hintRealise — valeurs possibles non observées empiriquement)
```

### 5.4 Options de requête (`TimetableOptions`)

```ts
type TimetableOptions = {
  withAbsences?: boolean;             // avecAbsencesEleve, défaut false
  weekNumber?: string;                // ignoré si from/to fournis
  from?: Date;
  to?: Date;
  withClassCouncil?: boolean;         // défaut true
  withFieldTrips?: boolean;           // défaut true
  withAvailabilities?: boolean;       // défaut true
  withGridPreferences?: boolean;      // défaut true
  withFreeResourcesFooter?: boolean;  // défaut false
  withStudentDetentions?: boolean;    // défaut true
  isPermanenceTimetable?: boolean;    // défaut false
}
```

Pour ce serveur mono-compte, tout laisser aux valeurs par défaut (ne rien
passer) sauf `from`/`to` dérivés des query params est amplement suffisant.

### 5.5 Contrat d'API JSON exposé au widget (mis à jour)

```
GET /api/v1/timetable?from=2026-09-07&to=2026-09-13
Header: Authorization: Bearer <API_KEY>
```

Réponse (fidèle aux types réels — tableaux plutôt que champs singuliers,
avec un discriminant `kind` pour distinguer cours/retenue) :

```json
{
  "generatedAt": "2026-09-06T08:00:00Z",
  "range": { "from": "2026-09-07", "to": "2026-09-13" },
  "days": [
    {
      "date": "2026-09-07",
      "lessons": [
        {
          "kind": "lesson",
          "start": "2026-09-07T08:00:00+02:00",
          "end": "2026-09-07T09:00:00+02:00",
          "subject": ["Mathématiques"],
          "teachers": ["M. Dupont"],
          "rooms": ["B204"],
          "groups": [],
          "staffs": [],
          "canceled": false,
          "status": null,
          "evaluation": false,
          "excluded": false,
          "backgroundColor": "#3E82F7",
          "videoconference": []
        },
        {
          "kind": "detention",
          "start": "2026-09-07T12:00:00+02:00",
          "end": "2026-09-07T13:00:00+02:00",
          "rooms": ["Salle de perm"],
          "staffs": ["Mme Martin"],
          "state": "à faire",
          "excluded": false
        }
      ]
    }
  ]
}
```

> ⚠️ **Points ouverts avant de figer ce contrat définitivement** (voir §12) :
> - Fuseau horaire réel des `Date` retournées par `DateParser` — à vérifier
>   avant de décider si le serveur peut se contenter de `.toISOString()` ou
>   doit forcer `Europe/Paris`.
> - Valeurs réelles possibles pour `status` (Lesson) et `state` (Detention) —
>   à observer sur un vrai emploi du temps contenant un cours modifié / une
>   retenue à des états différents.
> - Si le widget Android préfère des champs singuliers (`room`, `teacher`)
>   plutôt que des tableaux pour simplifier l'affichage, c'est une
>   simplification à faire *consciemment* côté serveur (avec perte
>   d'information en cas de co-enseignement ou salle partagée) — pas une
>   contrainte de la lib.

Plus, en bonus utile pour le monitoring :

```
GET /api/v1/health   →  200 OK  (pas d'auth requise)
```

---

## 6. Gestion des erreurs PRONOTE

### 6.1 Classes réelles (inspectées dans `src/structures/errors/*.ts`)

⚠️ **Piège découvert dans le code** : plusieurs classes d'erreur ont un bug où
leur propriété `.name` est codée en dur à `"AuthenticationError"` **quelle que
soit la classe réelle**. Il ne faut donc **jamais** distinguer ces erreurs
via `error.name === "..."`, mais toujours via `instanceof`.

| Classe réelle | Fichier | `.name` (⚠ souvent buggé) | Message par défaut | Propriétés propres | Code HTTP proposé |
|---|---|---|---|---|---|
| `SessionExpiredError` | `SessionExpiredError.ts` | `"AuthenticationError"` (bug) | "Your session has expired." | — | transparent, retry auto (§4.3) |
| `AuthenticationError` | `AuthenticationError.ts` | `"AuthenticationError"` (correct) | message custom passé au constructeur | — | `500` (alerte) — identifiants en env invalides |
| `AccessDeniedError` | `AccessDeniedError.ts` | `"AuthenticationError"` (bug) | "Access to this resource has been denied." | — | `403` |
| `DoubleAuthError` | `DoubleAuthError.ts` | `"DoubleAuthError"` (correct) | custom | `context: AccountSecurity`, `options?: {pin?: string}` | `500` (alerte, config à revoir) — endroit exact d'émission non identifié, cf §4.2 |
| `RateLimitError` | `RateLimitError.ts` | `"AuthenticationError"` (bug) | "You have been ratelimited" | — | `429` |
| `NetworkError` | `NetworkError.ts` | `"NetworkError"` (correct) | custom | `code: number` | `502` — seule erreur avec un code exploitable (`error.code`) |
| `UnavailableError` | `UnavailableError.ts` | `"AuthenticationError"` (bug) | "This resource is unavailable." | — | `502` |
| `CryptographicError` | `CryptographicError.ts` | `"CryptographicError"` (correct) | custom | — | `500` |
| `ParsingError` | `ParsingError.ts` | `"ParsingError"` (correct) | "Unable to parse Object" | `type: number`, `obj: unknown` | `500` — logger `type`/`obj` pour debug (attention à ne pas logger de payload PRONOTE sensible) |
| `SuspendedError` | `SuspendedError.ts` | `"AuthenticationError"` (bug) | **"Your IP has been suspended."** | — | `403` — ⚠️ correction par rapport à la v1 : c'est l'**IP du serveur** qui est bloquée par l'établissement, pas le "compte suspendu" — à documenter différemment côté monitoring (alerte réseau, pas alerte compte) |

### 6.2 Code de gestion recommandé

```ts
import {
  SessionExpiredError, AuthenticationError, AccessDeniedError,
  DoubleAuthError, RateLimitError, NetworkError, UnavailableError,
  CryptographicError, ParsingError, SuspendedError
} from "blocksnote";

try {
  return await callPronote();
} catch (err) {
  if (err instanceof SessionExpiredError) {
    await reauthenticate();      // §4.3, une seule tentative
    return await callPronote();  // rejoue une fois
  }
  if (err instanceof RateLimitError) return c.json({ error: "rate_limited" }, 429);
  if (err instanceof NetworkError || err instanceof UnavailableError)
    return c.json({ error: "pronote_unavailable" }, 502);
  if (err instanceof SuspendedErro