import { Instance } from "../src/structures/Instance";
import { AdministratorAuthenticator } from "../src/structures/authentication/AdministratorAuthenticator";
import { AssistantAuthenticator } from "../src/structures/authentication/AssistantAuthenticator";
import { CompanyAuthenticator } from "../src/structures/authentication/CompanyAuthenticator";
import { ParentAuthenticator } from "../src/structures/authentication/ParentAuthenticator";
import { SchoolLifeAuthenticator } from "../src/structures/authentication/SchoolLifeAuthenticator";
import { StudentAuthenticator } from "../src/structures/authentication/StudentAuthenticator";
import { TeacherAuthenticator } from "../src/structures/authentication/TeacherAuthenticator";
import { AccessDeniedError } from "../src/structures/errors/AccessDeniedError";
import { AuthenticationError } from "../src/structures/errors/AuthenticationError";
import { CryptographicError } from "../src/structures/errors/CryptographicError";
import { DoubleAuthError } from "../src/structures/errors/DoubleAuthError";
import { NetworkError } from "../src/structures/errors/NetworkError";
import { ParsingError } from "../src/structures/errors/ParsingError";
import { RateLimitError } from "../src/structures/errors/RateLimitError";
import { SessionExpiredError } from "../src/structures/errors/SessionExpired";
import { SuspendedError } from "../src/structures/errors/SuspendedError";
import { UnavailableError } from "../src/structures/errors/UnavailableError";
import { Detention } from "../src/routes/PageEmploiDuTemps/Detention";
import type { Timetable } from "../src/routes/PageEmploiDuTemps/Common";
import { Lesson } from "../src/routes/PageEmploiDuTemps/Lesson";
import type { StudentUserSettings } from "../src/routes/ParametresUtilisateurs/Student";
import { Administrator } from "../src/structures/users/Administrator";
import { Assistant } from "../src/structures/users/Assistant";
import { Company } from "../src/structures/users/Company";
import { Parent } from "../src/structures/users/Parent";
import { SchoolLife } from "../src/structures/users/SchoolLife";
import { Student } from "../src/structures/users/Student";
import { Teacher } from "../src/structures/users/Teacher";
import type { Class } from "../src/types/user";

type Role = "student" | "teacher" | "parent" | "company" | "assistant" | "administrator" | "schoollife";
type TimetableUser = Student | Teacher | Parent | Company | Assistant | Administrator | SchoolLife;

const env = {
  schoolUrl: requiredEnv("PRONOTE_SCHOOL_URL"),
  username: requiredEnv("PRONOTE_USERNAME"),
  password: requiredEnv("PRONOTE_PASSWORD"),
  role: parseRole(requiredEnv("PRONOTE_ROLE")),
  apiKey: requiredEnv("API_KEY"),
  port: parsePort(process.env.PORT)
};

let cachedUser: TimetableUser | null = null;
let authenticationInFlight: Promise<TimetableUser> | null = null;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function parsePort(value?: string): number {
  if (!value) return 3000;
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error("PORT must be a number between 1 and 65535");
  }
  return port;
}

function parseRole(value: string): Role {
  const role = value.trim().toLowerCase().replace(/[-_]/g, "");
  if (role === "student") return "student";
  if (role === "teacher") return "teacher";
  if (role === "parent") return "parent";
  if (role === "company") return "company";
  if (role === "assistant") return "assistant";
  if (role === "administrator") return "administrator";
  if (role === "schoollife") return "schoollife";
  throw new Error(`Unsupported PRONOTE_ROLE: ${value}`);
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

function parseDateQuery(raw: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isAuthorized(request: Request): boolean {
  const value = request.headers.get("authorization")?.trim();
  if (!value) return false;
  if (value === env.apiKey) return true;
  const [scheme, token] = value.split(/\s+/, 2);
  if (!scheme || !token) return false;
  return scheme.toLowerCase() === "bearer" && token === env.apiKey;
}

function mapLesson(lesson: Lesson) {
  const subject = Array.isArray(lesson.subject)
    ? lesson.subject
    : lesson.subject
      ? [lesson.subject]
      : [];

  return {
    kind: "lesson",
    start: lesson.from.toISOString(),
    end: lesson.to.toISOString(),
    subject,
    teachers: lesson.teachers,
    rooms: lesson.rooms,
    groups: lesson.groups,
    staffs: lesson.staffs,
    canceled: lesson.canceled,
    status: lesson.status ?? null,
    evaluation: lesson.evaluation,
    excluded: lesson.excluded,
    backgroundColor: lesson.backgroundColor,
    videoconference: lesson.videoconference.map((item) => ({
      comment: item.comment,
      label: item.label,
      url: item.url.toString()
    }))
  };
}

function mapDetention(detention: Detention) {
  return {
    kind: "detention",
    start: detention.from.toISOString(),
    end: detention.to.toISOString(),
    rooms: detention.rooms,
    staffs: detention.staffs,
    state: detention.state,
    excluded: detention.excluded
  };
}

function toTimetablePayload(timetable: Timetable, requestedFrom?: Date, requestedTo?: Date) {
  const days = timetable.days.map((day) => ({
    date: toDateOnlyString(day.date),
    lessons: day.lessons.map((slot) => {
      if (slot instanceof Detention) return mapDetention(slot);
      return mapLesson(slot);
    })
  }));

  const firstDay = days.at(0);
  const lastDay = days.at(-1);
  const rangeFrom = requestedFrom ?? (firstDay ? new Date(`${firstDay.date}T00:00:00.000Z`) : undefined);
  const rangeTo = requestedTo ?? (lastDay ? new Date(`${lastDay.date}T00:00:00.000Z`) : undefined);

  return {
    generatedAt: new Date().toISOString(),
    range: {
      from: rangeFrom ? toDateOnlyString(rangeFrom) : null,
      to: rangeTo ? toDateOnlyString(rangeTo) : null
    },
    days
  };
}

async function authenticate(): Promise<TimetableUser> {
  const instance = await Instance.createFromURL(env.schoolUrl);
  const authenticator = env.role === "student"
    ? new StudentAuthenticator(instance)
    : env.role === "teacher"
      ? new TeacherAuthenticator(instance)
      : env.role === "parent"
        ? new ParentAuthenticator(instance)
        : env.role === "company"
          ? new CompanyAuthenticator(instance)
          : env.role === "assistant"
            ? new AssistantAuthenticator(instance)
            : env.role === "administrator"
              ? new AdministratorAuthenticator(instance)
              : new SchoolLifeAuthenticator(instance);

  await authenticator.credentials(env.username, env.password);

  if (authenticator.security.mustEnterPIN || authenticator.security.mustChangePassword) {
    throw new DoubleAuthError(
      "Double authentication is enabled for this account and cannot be automated by this server.",
      authenticator.security
    );
  }

  return await authenticator.finalize() as TimetableUser;
}

async function getUser(): Promise<TimetableUser> {
  if (cachedUser) return cachedUser;
  if (!authenticationInFlight) {
    authenticationInFlight = authenticate()
      .then((user) => {
        cachedUser = user;
        return user;
      })
      .finally(() => {
        authenticationInFlight = null;
      });
  }
  return await authenticationInFlight;
}

function resetAuthentication(): void {
  cachedUser = null;
  authenticationInFlight = null;
}

function resolveStudentTarget(user: Parent | Assistant | Company): StudentUserSettings {
  if (user instanceof Parent || user instanceof Assistant) {
    const child = user.user.childrens[0];
    if (!child) throw new Error("No child available for this account.");
    return child;
  }

  const student = user.user.students[0];
  if (!student) throw new Error("No student available for this account.");
  return student;
}

function resolveClassTarget(user: SchoolLife | Administrator): Class {
  const classroom = user.user.classes[0];
  if (!classroom) throw new Error("No class available for this account.");
  return classroom;
}

async function loadTimetable(user: TimetableUser, from?: Date, to?: Date): Promise<Timetable> {
  const options = from && to ? { from, to } : undefined;

  if (user instanceof Student || user instanceof Teacher) {
    return await user.timetable(options);
  }

  if (user instanceof Parent || user instanceof Assistant || user instanceof Company) {
    return await user.timetable(resolveStudentTarget(user), options);
  }

  if (user instanceof SchoolLife) {
    return await user.timetable([resolveClassTarget(user)], options);
  }

  if (user instanceof Administrator) {
    return await user.timetable(resolveClassTarget(user), options);
  }

  throw new Error("Unsupported account type for timetable.");
}

async function loadTimetableWithRetry(from?: Date, to?: Date): Promise<Timetable> {
  const user = await getUser();
  try {
    return await loadTimetable(user, from, to);
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      resetAuthentication();
      const refreshed = await getUser();
      return await loadTimetable(refreshed, from, to);
    }
    throw error;
  }
}

function mapError(error: unknown): Response {
  // Log complet côté serveur uniquement — jamais renvoyé au client.
  // error.constructor.name est fiable même là où error.name est buggé
  // dans Blocksnote (cf plusieurs classes qui codent "AuthenticationError" en dur).
  console.error(`[pronote] ${error?.constructor?.name ?? typeof error}:`, error);

  if (error instanceof RateLimitError) {
    return json({ error: "rate_limited" }, 429);
  }

  if (error instanceof AccessDeniedError || error instanceof SuspendedError) {
    // SuspendedError = IP bannie par l'établissement, pas le compte — même code HTTP
    // mais à surveiller différemment côté monitoring (alerte réseau, pas alerte compte).
    return json({ error: "access_denied" }, 403);
  }

  if (error instanceof NetworkError) {
    return json({ error: "pronote_unavailable", code: error.code }, 502);
  }

  if (error instanceof UnavailableError) {
    return json({ error: "pronote_unavailable" }, 502);
  }

  if (error instanceof SessionExpiredError) {
    // Ne devrait normalement pas arriver ici : loadTimetableWithRetry() la
    // rattrape déjà et retente une fois. Si elle remonte quand même, c'est que
    // le retry a aussi échoué → traiter comme un souci d'auth serveur.
    return json({ error: "session_refresh_failed" }, 502);
  }

  if (error instanceof DoubleAuthError) {
    return json({ error: "double_auth_required" }, 500);
  }

  if (error instanceof ParsingError) {
    return json({ error: "parsing_failed", type: error.type }, 500);
  }

  if (error instanceof AuthenticationError || error instanceof CryptographicError) {
    // Identifiants en env invalides ou bug crypto — nécessite une intervention
    // manuelle, ce n'est pas un cas "utilisateur" (compte serveur fixe).
    return json({ error: "authentication_failed" }, 500);
  }

  const message = error instanceof Error ? error.message : "Unknown server error";
  return json({ error: "internal_error", message }, 500);
}

const server = Bun.serve({
  port: env.port,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/v1/health") {
      return json({ status: "ok", generatedAt: new Date().toISOString() });
    }

    if (url.pathname !== "/api/v1/timetable") {
      return json({ error: "not_found" }, 404);
    }

    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }

    if (!isAuthorized(request)) {
      return unauthorized();
    }

    const fromRaw = url.searchParams.get("from");
    const toRaw = url.searchParams.get("to");

    if ((fromRaw && !toRaw) || (!fromRaw && toRaw)) {
      return json({ error: "invalid_range", message: "Both 'from' and 'to' query params are required together." }, 400);
    }

    let from: Date | undefined;
    let to: Date | undefined;
    if (fromRaw && toRaw) {
      from = parseDateQuery(fromRaw) ?? undefined;
      to = parseDateQuery(toRaw) ?? undefined;

      if (!from || !to) {
        return json({ error: "invalid_range", message: "'from' and 'to' must use YYYY-MM-DD format." }, 400);
      }
    }

    try {
      const timetable = await loadTimetableWithRetry(from, to);
      return json(toTimetablePayload(timetable, from, to));
    } catch (error) {
      return mapError(error);
    }
  }
});

console.log(`Blocksnote server listening on http://localhost:${server.port}`);
