
# Architecture â€” Serveur d'exposition de Blocksnote (mono-compte)

> **v2** â€” mis Ã  jour aprÃ¨s inspection du code source rÃ©el de Blocksnote
> (`src/structures/authentication/`, `src/routes/PageEmploiDuTemps/`,
> `src/structures/errors/`, `src/types/`). Ce document est conÃ§u pour Ãªtre
> suffisant Ã  lui seul pour implÃ©menter le serveur, sans avoir besoin de
> relire les sources de Blocksnote â€” sauf pour les quelques points encore
> ouverts listÃ©s en Â§12.

## 1. Objectif

Fournir une API HTTP minimale, qui encapsule Blocksnote (wrapper PRONOTE) et
expose une seule chose : **l'emploi du temps d'un unique compte**, configurÃ©
une bonne fois pour toutes cÃ´tÃ© serveur (pas de gestion multi-utilisateurs, pas
d'Ã©cran de configuration cÃ´tÃ© client). Le widget Android n'a besoin de parler
que HTTP + JSON, jamais le protocole PRONOTE.

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”        HTTPS (JSON)        â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”        Protocole PRONOTE
â”‚  Widget Android  â”‚  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–º  â”‚  Serveur (Bun +      â”‚  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–º  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚ (AppWidget /     â”‚  â—„â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€  â”‚  Blocksnote)         â”‚  â—„â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€  â”‚ PRONOTE  â”‚
â”‚  Glance)         â”‚     GET /timetable          â”‚  - 1 session PRONOTE â”‚     Instance/Session/       â”‚ (Ã©tabli- â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜                              â”‚  - 1 clÃ© d'API       â”‚     Request                 â”‚ ssement) â”‚
                                                  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜                              â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

ConsÃ©quence directe de la simplification : **pas de base de donnÃ©es, pas de
table de comptes, pas d'endpoint de crÃ©ation/suppression de compte**. Tout est
dÃ©fini une fois via la configuration du serveur (variables d'environnement).

---

## 2. Stack technique

| Composant | Choix | Raison |
|---|---|---|
| Runtime | Bun | dÃ©jÃ  utilisÃ© par Blocksnote |
| Librairie mÃ©tier | Blocksnote (dÃ©pendance locale, non publiÃ©e sur npm) | cÅ“ur du projet |
| Framework HTTP | [Hono](https://hono.dev) *(ou `Bun.serve` natif, largement suffisant vu le nombre de routes)* | routing + middlewares simples |
| Stockage | **aucun** | un seul compte, identifiants en variables d'environnement, session gardÃ©e en mÃ©moire process |
| Reverse proxy / TLS | Caddy (ou Nginx) devant le serveur Bun | HTTPS automatique |
| DÃ©ploiement | Docker (image `oven/bun`) sur un petit serveur perso / VPS / Raspberry Pi | portable, redÃ©marrage facile |

Suppression volontaire par rapport Ã  la v1 multi-compte : `bun:sqlite`,
`@noble/ciphers` pour chiffrer des identifiants stockÃ©s, table `accounts`. Les
identifiants restent en variables d'environnement (pratique standard, au mÃªme
niveau de confiance qu'un `SERVER_SECRET`), il n'y a donc plus rien Ã  chiffrer
cÃ´tÃ© serveur.

---

## 3. Configuration (variables d'environnement)

| Variable | Exemple | Description |
|---|---|---|
| `PRONOTE_SCHOOL_URL` | `https://demo.index-education.net/pronote/` | URL de l'Ã©tablissement |
| `PRONOTE_USERNAME` | `jdupont` | identifiant PRONOTE |
| `PRONOTE_PASSWORD` | `********` | mot de passe PRONOTE |
| `PRONOTE_ROLE` | `student` | mappÃ© sur le bon `Authenticator` et sur `NOTSpace`, voir tableau ci-dessous |
| `API_KEY` | valeur alÃ©atoire gÃ©nÃ©rÃ©e une fois (ex. `openssl rand -hex 32`) | protÃ¨ge l'unique endpoint exposÃ©, Ã  copier dans le widget Android |
| `PORT` | `3000` | port d'Ã©coute du serveur |

### Mapping `PRONOTE_ROLE` â†’ classes Blocksnote

ConfirmÃ© par inspection de `src/structures/authentication/*.ts` et
`src/types/authentication.ts` :

| `PRONOTE_ROLE` | Classe `Authenticator` | `NOTSpace` (valeur numÃ©rique) | Classe `User` retournÃ©e par `finalize()` |
|---|---|---|---|
| `student` | `StudentAuthenticator` | `STUDENT` (6) | `Student` |
| `teacher` | `TeacherAuthenticator` | `TEACHER` (8) | `Teacher` |
| `parent` | `ParentAuthenticator` | `PARENT` (7) | `Parent` |
| `company` | `CompanyAuthenticator` | `ENTERPRISE` (39) | `Company` |
| `assistant` | `AssistantAuthenticator` | `ACCOMPANYING` (26) | `Assistant` |
| `administrator` | `AdministratorAuthenticator` | `ADMINISTRATOR` (17) | `Administrator` |
| `schoolLife` | `SchoolLifeAuthenticator` | `SCHOOL_LIFE` (14) | `SchoolLife` |

Chaque `XAuthenticator` sÃ©lectionne automatiquement le bon `workspace` dans
`instance.workspaces` en filtrant sur ce `type` â€” le serveur n'a donc qu'Ã 
choisir la bonne classe `Authenticator` selon `PRONOTE_ROLE`, rien d'autre Ã 
mapper manuellement.

Ces variables suffisent Ã  dÃ©marrer le serveur : pas de fichier de config
additionnel, pas de secret maÃ®tre Ã  gÃ©rer sÃ©parÃ©ment.

---

## 4. Cycle de vie de la session PRONOTE

### 4.1 Flux d'authentification rÃ©el

Le flux **n'est pas** "configurer les credentials puis appeler `finalize()`"
comme une premiÃ¨re version de ce document le supposait. Il y a deux appels
distincts, dont un asynchrone qui fait tout le travail lourd :

```ts
import { Instance } from "blocksnote";
import { StudentAuthenticator } from "blocksnote"; // classe choisie selon PRONOTE_ROLE, cf Â§3

// 1. RÃ©solution de l'Ã©tablissement
const instance = await Instance.createFromURL(PRONOTE_SCHOOL_URL);

// 2. CrÃ©ation de l'authenticator (sÃ©lectionne automatiquement le bon workspace)
const authenticator = new StudentAuthenticator(instance);

// 3. Ã‰change complet : crÃ©e la Session, charge les Settings, rÃ©sout le Challenge,
//    envoie "Authentification" Ã  PRONOTE, Ã©change la clÃ© AES. Tout est fait ici.
await authenticator.credentials(PRONOTE_USERNAME, PRONOTE_PASSWORD);

// 4. VÃ©rification double authentification AVANT finalize() â€” voir Â§4.2, point critique
const security = authenticator.security;
if (security.mustEnterPIN || security.mustChangePassword) {
  // Pas automatisable avec juste username/password en env â€” traiter comme erreur
  // de configuration serveur (log alerte, ne pas retenter en boucle).
  throw new Error("Double authentification active sur ce compte PRONOTE â€” non gÃ©rable en mode serveur automatisÃ©");
}

// 5. Finalisation : appelle en interne validate() â†’ security.execute() (no-op si
//    aucun mot de passe/pin fourni, cf Â§4.2) puis charge l'objet User
const user = await authenticator.finalize(); // -> Student (ou Teacher, Parent, etc.)
```

`user.session` est l'objet Ã  garder en mÃ©moire process (singleton du
serveur) : c'est lui qui porte la clÃ© AES active et le `RequestManager` utilisÃ©
pour toutes les requÃªtes suivantes (dont le rechargement de l'emploi du temps).

### 4.2 âš ï¸ Point critique : la double authentification n'est PAS automatiquement bloquante

`AccountSecurity.execute()` (appelÃ©e en interne par `finalize()` via
`validate()`) contient ce garde-fou :

```ts
public async execute(): Promise<this> {
  if ((this._device && !this._pin && !this._mode) || !this._password) return this;
  // ... sinon envoie une requÃªte "SecurisationCompteDoubleAuth"
}
```

Tant que le serveur n'appelle jamais explicitement `.password()`, `.pin()` ou
`.register()` sur `authenticator.security`, `_password` reste `undefined` et
la mÃ©thode **retourne silencieusement sans rien envoyer, sans lever
d'exception**. Autrement dit : `finalize()` peut rÃ©ussir "normalement" mÃªme
si le compte a la double authentification activÃ©e cÃ´tÃ© Ã©tablissement.

ConsÃ©quence pour l'implÃ©mentation :
- Il faut **vÃ©rifier explicitement** `authenticator.security.mustEnterPIN` et
  `authenticator.security.mustChangePassword` juste aprÃ¨s `credentials()`,
  avant d'appeler `finalize()` (code ci-dessus).
- **Point ouvert** (voir Â§12) : on n'a pas identifiÃ© dans le code inspectÃ©
  l'endroit exact oÃ¹ `DoubleAuthError` (classe dÃ©finie dans
  `src/structures/errors/DoubleAuthError.ts`, jamais vue instanciÃ©e) est
  effectivement levÃ©e. Il est possible qu'elle soit levÃ©e plus loin, lors
  d'un appel `PageEmploiDuTemps` qui Ã©chouerait silencieusement cÃ´tÃ© PRONOTE
  si la double auth n'a pas Ã©tÃ© validÃ©e. Ã€ tester empiriquement avec le
  compte rÃ©el, ou Ã  vÃ©rifier en lisant `Request.ts` / `RequestManager.ts`
  (non inspectÃ©s).
- Recommandation pratique : **utiliser un compte PRONOTE sans double
  authentification activÃ©e** pour ce serveur, pour Ã©viter ce cas limite non
  automatisable de toute faÃ§on (pas d'interaction humaine possible cÃ´tÃ©
  serveur).

### 4.3 RÃ©utilisation et expiration de la session

1. **Au dÃ©marrage** (ou paresseusement, au premier appel Ã  `/timetable`) :
   flux complet du Â§4.1.
2. **Ã€ chaque appel** Ã  `/timetable` : rÃ©utilisation de `user.session` en
   mÃ©moire (variable module-level, singleton).
3. **Si la session est expirÃ©e** : Blocksnote lÃ¨ve `SessionExpiredError`
   (nom rÃ©el de la classe, diffÃ©rent de ce qui avait Ã©tÃ© supposÃ© en v1 â€” voir
   Â§6 pour le dÃ©tail des classes d'erreur rÃ©elles). Le serveur relance
   automatiquement le flux du Â§4.1 avec les mÃªmes identifiants (toujours
   disponibles en variables d'environnement), puis rejoue l'appel **une
   seule fois** (pas de retry rÃ©cursif, pour Ã©viter une boucle infinie si le
   nouveau login Ã©choue aussi pour une autre raison).

Pas de notion de "compte" Ã  crÃ©er/supprimer : la configuration au dÃ©marrage
*est* le compte.

---

## 5. RÃ©cupÃ©ration de l'emploi du temps

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
mÃ©thode **protÃ©gÃ©e** `_timetable()` qui calcule le paramÃ¨tre `ressource` et
fournit une valeur par dÃ©faut pratique pour `from`/`to` :

```ts
protected _timetable(
  target: Class | StudentUserSettings | TeacherUserSettings | Class[],
  options?: TimetableOptions
): Promise<Timetable> {
  const res = Array.isArray(target)
    ? target.map((t) => ({ G: t.kind, N: t.id }))
    : { G: target.kind, N: target.id };

  if (!options?.from || !options?.to) {
    // Calcule automatiquement la semaine civile courante (lundi â†’ dimanche)
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
- **`from`/`to` sont des objets `Date` JS**, pas des strings â€” le serveur doit
  parser les query params `?from=2026-09-07&to=2026-09-13` en `Date` avant
  d'appeler la mÃ©thode de timetable.
- Si `from`/`to` ne sont **pas** fournis par le widget, on peut simplement ne
  pas les passer : la lib calcule elle-mÃªme la semaine civile courante. Pas
  besoin de dupliquer cette logique cÃ´tÃ© serveur.
- **Point ouvert** (voir Â§12) : `_timetable()` est `protected`, donc appelÃ©e
  en interne par une mÃ©thode publique de `Student` (ou `Teacher`, etc.) qu'on
  n'a pas encore inspectÃ©e (`src/structures/users/Student.ts`). Il faut lire
  ce fichier pour connaÃ®tre le nom exact de la mÃ©thode publique Ã  appeler
  cÃ´tÃ© serveur (probablement quelque chose comme `student.timetable(options)`
  qui appelle en interne `this._timetable(this.user, options)`, mais Ã 
  confirmer â€” ne pas deviner l'implÃ©mentation).

### 5.2 Types de rÃ©ponse PRONOTE (confirmÃ©s)

```ts
// src/types/responses/timetable.ts
type CommunPageEmploiDuTempsResponse = {
  ListeCours: PronoteCourse[];
  absences?: { joursCycle: JourAbsence[] };
}

type PronoteCourse = {
  estRetenue?: string;        // prÃ©sence de ce champ â†’ c'est une "Detention"
  AvecCdT: boolean;
  AvecTafPublie: boolean;
  CouleurFond: string;
  DateDuCours: Date;
  duree: number;
  place: number;
  ListeContenus: PronoteContent[];
  Statut?: string;            // valeurs possibles non observÃ©es empiriquement
  estAnnule?: boolean;
  cahierDeTextes?: { estEval: boolean } & PronoteLabel;
  listeVisios?: PronoteVisio[];
  hintRealise?: string;
}
```

`Timetable.lessons` transforme chaque `PronoteCourse` en `Lesson` (cours
normal) ou `Detention` (retenue) selon la prÃ©sence de `estRetenue` :

```ts
// src/routes/PageEmploiDuTemps/Common.ts
private static addTimeSlot(course, timetable, settings): TimeSlot {
  if (course.estRetenue) return new Detention(course, timetable, settings);
  return new Lesson(course, timetable, settings);
}
```

`Timetable.days` groupe ensuite les crÃ©neaux par date civile (attention :
malgrÃ© le typage `Lesson[] | Detention[]` du type `TimetableDay`, en pratique
le tableau `lessons` d'un jour peut mÃ©langer les deux types â€” c'est un
tableau hÃ©tÃ©rogÃ¨ne, il faut le gÃ©rer comme tel cÃ´tÃ© mapping JSON).

### 5.3 Champs exposÃ©s par crÃ©neau (`TimeSlot`, `Lesson`, `Detention`)

```
TimeSlot (base commune)
â”œâ”€â”€ from: Date                (raw.DateDuCours)
â”œâ”€â”€ to: Date                  (from + duration)
â”œâ”€â”€ duration: number          (ms â€” calculÃ© depuis raw.duree et settings.schedule.seatsPerHour)
â”œâ”€â”€ rooms: string[]           (content type 17 â€” PLURIEL, un crÃ©neau peut avoir plusieurs salles)
â”œâ”€â”€ staffs: string[]          (content type 34 â€” distinct de "teachers")
â””â”€â”€ excluded: boolean         (crÃ©neau dans une plage exclue par une absence d'Ã©tablissement)

Lesson extends TimeSlot
â”œâ”€â”€ subject: string | string[] | undefined   (content type 16, âš  type incohÃ©rent dans la lib â€” toujours un tableau en pratique via content(), donc probablement toujours string[] ou undefined malgrÃ© le typage)
â”œâ”€â”€ teachers: string[]        (content type 3 â€” PLURIEL, co-enseignement possible)
â”œâ”€â”€ groups: string[]          (content type 2)
â”œâ”€â”€ canceled: boolean         (raw.estAnnule â€” boolÃ©en fiable, pas besoin de parser un statut texte)
â”œâ”€â”€ status: string | undefined  (raw.Statut â€” texte brut PRONOTE, ex. "ModifiÃ©" Ã  confirmer empiriquement)
â”œâ”€â”€ evaluation: boolean       (raw.cahierDeTextes?.estEval â€” contrÃ´le/devoir notÃ©)
â”œâ”€â”€ backgroundColor: string   (raw.CouleurFond, format hex probable)
â””â”€â”€ videoconference: Videoconference[]
      { comment?: string; label?: string; url: URL }

Detention extends TimeSlot
â””â”€â”€ state: string             (raw.hintRealise â€” valeurs possibles non observÃ©es empiriquement)
```

### 5.4 Options de requÃªte (`TimetableOptions`)

```ts
type TimetableOptions = {
  withAbsences?: boolean;             // avecAbsencesEleve, dÃ©faut false
  weekNumber?: string;                // ignorÃ© si from/to fournis
  from?: Date;
  to?: Date;
  withClassCouncil?: boolean;         // dÃ©faut true
  withFieldTrips?: boolean;           // dÃ©faut true
  withAvailabilities?: boolean;       // dÃ©faut true
  withGridPreferences?: boolean;      // dÃ©faut true
  withFreeResourcesFooter?: boolean;  // dÃ©faut false
  withStudentDetentions?: boolean;    // dÃ©faut true
  isPermanenceTimetable?: boolean;    // dÃ©faut false
}
```

Pour ce serveur mono-compte, tout laisser aux valeurs par dÃ©faut (ne rien
passer) sauf `from`/`to` dÃ©rivÃ©s des query params est amplement suffisant.

### 5.5 Contrat d'API JSON exposÃ© au widget (mis Ã  jour)

```
GET /api/v1/timetable?from=2026-09-07&to=2026-09-13
Header: Authorization: Bearer <API_KEY>
```

RÃ©ponse (fidÃ¨le aux types rÃ©els â€” tableaux plutÃ´t que champs singuliers,
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
          "subject": ["MathÃ©matiques"],
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
          "state": "Ã  faire",
          "excluded": false
        }
      ]
    }
  ]
}
```

> âš ï¸ **Points ouverts avant de figer ce contrat dÃ©finitivement** (voir Â§12) :
> - Fuseau horaire rÃ©el des `Date` retournÃ©es par `DateParser` â€” Ã  vÃ©rifier
>   avant de dÃ©cider si le serveur peut se contenter de `.toISOString()` ou
>   doit forcer `Europe/Paris`.
> - Valeurs rÃ©elles possibles pour `status` (Lesson) et `state` (Detention) â€”
>   Ã  observer sur un vrai emploi du temps contenant un cours modifiÃ© / une
>   retenue Ã  des Ã©tats diffÃ©rents.
> - Si le widget Android prÃ©fÃ¨re des champs singuliers (`room`, `teacher`)
>   plutÃ´t que des tableaux pour simplifier l'affichage, c'est une
>   simplification Ã  faire *consciemment* cÃ´tÃ© serveur (avec perte
>   d'information en cas de co-enseignement ou salle partagÃ©e) â€” pas une
>   contrainte de la lib.

Plus, en bonus utile pour le monitoring :

```
GET /api/v1/health   â†’  200 OK  (pas d'auth requise)
```

---

## 6. Gestion des erreurs PRONOTE

### 6.1 Classes rÃ©elles (inspectÃ©es dans `src/structures/errors/*.ts`)

âš ï¸ **PiÃ¨ge dÃ©couvert dans le code** : plusieurs classes d'erreur ont un bug oÃ¹
leur propriÃ©tÃ© `.name` est codÃ©e en dur Ã  `"AuthenticationError"` **quelle que
soit la classe rÃ©elle**. Il ne faut donc **jamais** distinguer ces erreurs
via `error.name === "..."`, mais toujours via `instanceof`.

| Classe rÃ©elle | Fichier | `.name` (âš  souvent buggÃ©) | Message par dÃ©faut | PropriÃ©tÃ©s propres | Code HTTP proposÃ© |
|---|---|---|---|---|---|
| `SessionExpiredError` | `SessionExpiredError.ts` | `"AuthenticationError"` (bug) | "Your session has expired." | â€” | transparent, retry auto (Â§4.3) |
| `AuthenticationError` | `AuthenticationError.ts` | `"AuthenticationError"` (correct) | message custom passÃ© au constructeur | â€” | `500` (alerte) â€” identifiants en env invalides |
| `AccessDeniedError` | `AccessDeniedError.ts` | `"AuthenticationError"` (bug) | "Access to this resource has been denied." | â€” | `403` |
| `DoubleAuthError` | `DoubleAuthError.ts` | `"DoubleAuthError"` (correct) | custom | `context: AccountSecurity`, `options?: {pin?: string}` | `500` (alerte, config Ã  revoir) â€” endroit exact d'Ã©mission non identifiÃ©, cf Â§4.2 |
| `RateLimitError` | `RateLimitError.ts` | `"AuthenticationError"` (bug) | "You have been ratelimited" | â€” | `429` |
| `NetworkError` | `NetworkError.ts` | `"NetworkError"` (correct) | custom | `code: number` | `502` â€” seule erreur avec un code exploitable (`error.code`) |
| `UnavailableError` | `UnavailableError.ts` | `"AuthenticationError"` (bug) | "This resource is unavailable." | â€” | `502` |
| `CryptographicError` | `CryptographicError.ts` | `"CryptographicError"` (correct) | custom | â€” | `500` |
| `ParsingError` | `ParsingError.ts` | `"ParsingError"` (correct) | "Unable to parse Object" | `type: number`, `obj: unknown` | `500` â€” logger `type`/`obj` pour debug (attention Ã  ne pas logger de payload PRONOTE sensible) |
| `SuspendedError` | `SuspendedError.ts` | `"AuthenticationError"` (bug) | **"Your IP has been suspended."** | â€” | `403` â€” âš ï¸ correction p