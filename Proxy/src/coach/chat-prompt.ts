import { COACH_CHAT_MAX_MESSAGES, truncateText, type CoachChatMessage } from "./chat";
import { localDateParts, validTimeZone } from "./local-time";
import { disciplineCoachSystemPrompt, disciplineCoachTemperament } from "./planner/coach-temperament";
import type { TrainingSignals } from "./planner/compute-training-signals";
import type {
  CoachContext,
  CoachEvaluation,
  CoachRequest,
  CoachSnapshot,
  CoachWellnessDay,
  PlannedExercisePrescription,
  PlannedSession,
  RunSummary,
  TrainingLog
} from "./planner/types";

// How much of the athlete's data the chat model sees. Summaries, not dumps:
// the chat is a phone conversation, and every token is paid for each turn.
const RECENT_RUNS_IN_PROMPT = 6;
const UPCOMING_SESSIONS_IN_PROMPT = 5;
const WELLNESS_DAYS_IN_PROMPT = 3;
const PROFILE_NOTE_MAX_LENGTH = 400;
const LOG_NOTE_MAX_LENGTH = 160;

/**
 * The coach-chat system prompt. The voice comes from the shared coach
 * temperament (the same one the plan and coach-read prompts use); the rules
 * keep answers grounded in the athlete's data, safe around pain, and honest
 * about what the chat can and cannot do.
 */
export const COACH_CHAT_SYSTEM_PROMPT = [
  "You are the coach inside lockin, answering one athlete in the app's coach chat. lockin plans calisthenics strength work (pull-ups, push-ups, plank) and, when the athlete has a race goal, running toward that race. You only talk about this athlete's own training.",
  "",
  "Voice",
  `- ${disciplineCoachSystemPrompt}`,
  `- Standards: ${disciplineCoachTemperament.standards.join(" ")}`,
  `- Avoid: ${disciplineCoachTemperament.avoid.join(" ")}`,
  "- Direct and specific. No empty praise, no hype, no filler such as \"Great question\". Use the athlete's actual numbers.",
  "",
  "How to answer",
  "1. Answer the latest message in your first sentence. Then give the reason from the data and one clear next step.",
  "2. Ground every claim in the athlete data message. Quote numbers exactly as given; never calculate new figures, estimate, or invent data. If what you need is missing (no runs logged, no Garmin data, no session today), say so plainly and answer with what you do have.",
  "3. coachRead is computed by code and is the source of truth for status, adherence, readiness, progress, the plan decision and the next action. Never contradict it.",
  "4. Use the conversation. A follow-up such as \"and tomorrow?\" or \"why?\" refers to the earlier turns. Build on your last answer instead of repeating it.",
  "",
  "Safety",
  "5. Pain or injury: never diagnose, name a condition, or guess a cause, and never encourage training through pain. Give conservative guidance: stop or reduce the movement that hurts and keep today's work easy and pain-free. If the pain is sharp, worsening, makes them limp, comes with swelling or numbness, or changes how they move, they should stop and get it checked by a doctor or physiotherapist. Pain that keeps coming back or lasts more than a few days also needs a professional. Mention the pain levels from the logs when they exist. Use answerKind \"pain\".",
  "6. Never prescribe medication, supplements, or medical treatment.",
  "",
  "The plan",
  "7. Only refer to sessions listed in todaySessions and upcomingSessions. Never invent a workout, distance, pace, or rest day that is not planned. If todaySessions is empty, there is no training planned today.",
  "8. You cannot change the plan from this chat. If the athlete asks to change, move, add, or skip training, say what you as their coach would change and why, then explain that lockin rebuilds the plan from their logs automatically every night and after they log training, and that they can rebuild it now with \"Create week schedule\" on the Coach screen. Logging how sessions really went (effort, pain, how it felt) is what moves the plan. Never claim you changed, moved, booked, or logged anything.",
  "9. Do not add training beyond the plan. When readiness or pain says back off, say back off.",
  "",
  "Scope and format",
  "10. You only know the athlete's lockin training data. You have no live weather, news, or web lookup; say so in one sentence and steer back to training.",
  "11. Keep it short for a phone: 60 to 180 words, plain sentences, short paragraphs. No headings, tables, or markdown emphasis. A list of at most 3 short items is fine when it really helps.",
  "12. Reply in the language of the athlete's latest message. Use km, m and minutes; write pace as min:ss per km.",
  "13. Never mention JSON, field names, code-like labels (snake_case or camelCase), schemas, the app's internals, or \"the data provided\". Say \"your logs\", \"your runs\", \"your Garmin data\", \"your plan\".",
  "",
  "Output fields",
  "- answer: the reply shown to the athlete.",
  "- evidence: 1 to 4 short data points you actually used, in athlete language, each under 80 characters, for example \"Pain 4/10 on 21 Jun\" or \"24.6 km in the last 7 days\". Empty when you used no data.",
  "- followUpPrompts: 2 or 3 short questions the athlete might ask you next, written as the athlete, under 60 characters each, in the athlete's language. Do not repeat the question just asked.",
  "- answerKind: the closest category for the latest message: working (am I doing well overall), schedule (race, goals, long-term timeline), improvement (weak points, what to focus on), motivation, fatigue (tiredness, sleep, recovery, readiness), pain (pain, injury, soreness), today (today's or the next session), unsupported (outside your scope), general (anything else, including requests to change the plan)."
].join("\n");

export type CoachChatPromptInput = {
  messages: CoachChatMessage[];
  context: CoachContext;
  signals: TrainingSignals | null;
  evaluation: CoachEvaluation & { snapshot: CoachSnapshot };
  request: CoachRequest;
  now?: Date;
};

type ResponsesInputMessage = { role: "system" | "user" | "assistant"; content: string };

/** The Responses API `input`: rules, the athlete data, then the conversation ending on the latest question. */
export function buildCoachChatModelInput(input: CoachChatPromptInput): ResponsesInputMessage[] {
  const payload = buildCoachChatContextPayload(input);
  return [
    { role: "system", content: COACH_CHAT_SYSTEM_PROMPT },
    {
      role: "system",
      content: `Athlete data from lockin, computed by code today. It is the only source of facts about this athlete:\n${JSON.stringify(payload)}`
    },
    ...conversationForModel(input.messages)
  ];
}

/** The last turns of the chat, ending on the athlete's latest message. */
export function conversationForModel(messages: CoachChatMessage[]): ResponsesInputMessage[] {
  const recent = messages.slice(-COACH_CHAT_MAX_MESSAGES);
  let lastUserIndex = -1;
  recent.forEach((message, index) => {
    if (message.role === "user") lastUserIndex = index;
  });
  return recent
    .slice(0, lastUserIndex + 1)
    .filter((message) => message.text.trim().length > 0)
    .map((message) => ({
      role: message.role === "user" ? "user" : "assistant",
      content: message.text.trim()
    }));
}

/** A compact, athlete-language summary of everything the coach knows. */
export function buildCoachChatContextPayload(input: CoachChatPromptInput): Record<string, unknown> {
  const { context, signals, evaluation, request } = input;
  const timeZone = validTimeZone(request.timeZone) ?? "UTC";
  const now = input.now ?? new Date();
  const todayIds = new Set(context.plannedWork.todaySessions.map((session) => session.id));
  const sessionsById = new Map((request.plannedSessions ?? []).map((session) => [session.id, session]));
  const todayStart = Date.parse(context.profile.weekStart);
  const todayDate = Number.isFinite(todayStart) ? new Date(todayStart) : now;

  return compact({
    today: dayLabel(todayDate, timeZone),
    athlete: {
      strengthGoals: {
        pullUps: context.profile.goals.pullUps,
        pushUps: context.profile.goals.pushUps,
        plankSeconds: context.profile.goals.plankSeconds,
        targetDate: dateOnly(context.profile.targetDate, timeZone)
      },
      startingBaseline: context.profile.baseline,
      bestRecent: context.history.bestRecentTests,
      strengthDaysPerWeek: context.profile.weeklySessions,
      strengthDays: context.profile.trainingDays,
      equipment: context.profile.equipment,
      profileNotes: context.profile.profileNotes ? truncateText(context.profile.profileNotes, PROFILE_NOTE_MAX_LENGTH) : null
    },
    race: context.running
      ? {
          name: context.running.raceGoal.name,
          date: dateOnly(context.running.raceGoal.raceDate, timeZone),
          distanceKm: context.running.raceGoal.distanceKm,
          elevationGainM: context.running.raceGoal.elevationGainM,
          daysToRace: signals?.race?.daysToRace ?? null,
          weeksToRace: signals?.race?.weeksToRace ?? context.running.weeksToRace,
          phase: signals?.race ? humanize(signals.race.taperStatus) : null,
          runningDays: context.running.runningDays,
          longRunDay: context.running.longRunDay ?? null,
          startingWeeklyKm: context.running.baselineWeeklyKm,
          startingLongestRunKm: context.running.longestRecentRunKm
        }
      : null,
    coachRead: {
      status: evaluation.statusLabel,
      adherence: {
        completedPct: evaluation.adherence.completedPct,
        standardPct: evaluation.adherence.standardPct,
        dueSessions: evaluation.adherence.dueSessions,
        completed: evaluation.adherence.completedSessions,
        partial: evaluation.adherence.partialSessions,
        missed: evaluation.adherence.missedSessions,
        note: evaluation.adherence.rationale
      },
      readiness: {
        state: humanize(evaluation.readiness.state),
        painOrFatigueFlag: evaluation.readiness.painOrFatigueFlag,
        hrvGate: evaluation.readiness.hrvGate ? humanize(evaluation.readiness.hrvGate) : null,
        garminTrainingReadiness: evaluation.readiness.trainingReadiness,
        note: evaluation.readiness.rationale
      },
      progress: {
        state: humanize(evaluation.progress.state),
        flatGoalWork: evaluation.progress.flatGoalMetrics,
        note: evaluation.progress.rationale
      },
      planDecision: {
        action: humanize(evaluation.planDecision.action),
        note: evaluation.planDecision.rationale
      },
      nextAction: evaluation.nextAction
    },
    riskFlags: context.readiness.riskFlags.map(humanize),
    strength: {
      twoMonthTrend: humanize(context.history.twoFullMonthTrend.label),
      goalWorkVsPrescription: goalWorkVsPrescription(context),
      effortVsPlan: {
        averageRpeAbovePlanLast5: context.history.rpeCalibration.averageDeltaLast5,
        sessionsTwoOrMoreAbovePlan: context.history.rpeCalibration.abovePlanBy2Count
      },
      recentLogs: [...context.history.last5Logs]
        .reverse()
        .map((log) => strengthLogSummary(log, sessionsById.get(log.sessionId), timeZone))
    },
    todaySessions: context.plannedWork.todaySessions.map((session) =>
      sessionSummary(sessionsById.get(session.id) ?? { ...session, exercises: [] }, timeZone)
    ),
    upcomingSessions: (request.plannedSessions ?? [])
      .filter((session) => {
        const scheduled = Date.parse(session.scheduledDate);
        return session.status === "planned" && !todayIds.has(session.id) && Number.isFinite(scheduled) && scheduled >= todayDate.getTime();
      })
      .sort((a, b) => Date.parse(a.scheduledDate) - Date.parse(b.scheduledDate))
      .slice(0, UPCOMING_SESSIONS_IN_PROMPT)
      .map((session) => sessionSummary(session, timeZone)),
    running: signals
      ? {
          last7DaysKm: round1(signals.running.last7DaysKm),
          prior7DaysKm: round1(signals.running.prior7DaysKm),
          fourWeekAverageKmPerWeek: round1(signals.running.fourWeekAvgKm),
          last7DaysVsFourWeekAveragePct: signals.running.volumeVsFourWeekPct,
          runsLast7Days: signals.running.runCountLast7Days,
          last7DaysClimbM: signals.running.last7DaysAscentM,
          last7DaysDescentM: signals.running.last7DaysDescentM,
          longestRunLast6WeeksKm: round1(signals.running.longestRunLast6WeeksKm),
          recentLongRunsKm: signals.running.recentLongRunsKm.map(round1),
          easySharePctLast4Weeks:
            signals.running.easyShareLast4Weeks === null ? null : Math.round(signals.running.easyShareLast4Weeks * 100),
          recentRuns: [...(context.running?.recentRuns ?? [])]
            .slice(-RECENT_RUNS_IN_PROMPT)
            .reverse()
            .map((run) => runSummary(run, timeZone))
        }
      : null,
    garminWellness: (context.garmin?.wellness ?? []).length > 0
      ? {
          hrvGate: signals?.wellness?.hrvGate ? humanize(signals.wellness.hrvGate) : null,
          days: [...(context.garmin?.wellness ?? [])]
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(-WELLNESS_DAYS_IN_PROMPT)
            .reverse()
            .map(wellnessSummary)
        }
      : null
  });
}

function goalWorkVsPrescription(context: CoachContext): Record<string, unknown> | null {
  const performance = context.plannedWork.recentGoalPerformance;
  if (!performance) return null;
  const entries = (["pullUps", "pushUps", "plankSeconds"] as const).flatMap((metric) => {
    const item = performance[metric];
    if (item.prescribedTarget === null || item.latestLoggedBest === null) return [];
    return [[metric, {
      prescribed: item.prescribedTarget,
      sets: item.prescribedSets,
      latestLogged: item.latestLoggedBest,
      difference: item.delta,
      cleanCompletion: item.clean,
      cleanCompletionsInARow: item.consecutiveCleanCompletionsAtStandard
    }]] as const;
  });
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function strengthLogSummary(log: TrainingLog, session: PlannedSession | undefined, timeZone: string): Record<string, unknown> {
  const logged = [
    log.loggedPullUps ? `pull-ups ${log.pullUps}` : null,
    log.loggedPushUps ? `push-ups ${log.pushUps}` : null,
    log.loggedPlankSeconds ? `plank ${log.plankSeconds}s` : null
  ].filter((item): item is string => item !== null);
  const plannedRPE = typeof log.plannedRPE === "number" ? log.plannedRPE : null;

  return compact({
    date: dayLabel(new Date(log.completedAt), timeZone),
    session: session?.title ?? null,
    prescribed: session ? exercisesSummary(session.exercises ?? []) : null,
    logged: logged.length > 0 ? logged.join(", ") : "no goal reps logged",
    effort: plannedRPE === null ? `RPE ${log.rpe}` : `RPE ${log.rpe} (planned ${plannedRPE})`,
    pain: log.painLevel,
    fatigue: log.fatigueLevel,
    felt: log.howYouFelt ? humanize(log.howYouFelt) : null,
    notes: log.notes?.trim() ? truncateText(log.notes.trim().replace(/\s+/g, " "), LOG_NOTE_MAX_LENGTH) : null
  });
}

function sessionSummary(session: PlannedSession, timeZone: string): Record<string, unknown> {
  return compact({
    date: dayLabel(new Date(session.scheduledDate), timeZone),
    title: session.title,
    focus: session.focus,
    status: session.status,
    work: exercisesSummary(session.exercises ?? [])
  });
}

function exercisesSummary(exercises: PlannedExercisePrescription[]): string | null {
  if (exercises.length === 0) return null;
  return exercises
    .map((exercise) => {
      const amount = exercise.targetSeconds > 0
        ? `${exercise.sets}x${exercise.targetSeconds}s`
        : `${exercise.sets}x${exercise.targetReps}`;
      const effort = exercise.plannedEffortLabel ? ` ${humanize(exercise.plannedEffortLabel)}` : "";
      return `${exerciseName(exercise.exercise)} ${amount}${effort}`;
    })
    .join(", ");
}

function runSummary(run: RunSummary, timeZone: string): Record<string, unknown> {
  const pace = run.distanceKm > 0 && run.movingSeconds > 0 ? run.movingSeconds / run.distanceKm : null;
  return compact({
    date: dayLabel(new Date(run.completedAt), timeZone),
    kind: run.kind ?? null,
    distanceKm: round1(run.distanceKm),
    duration: formatDuration(run.movingSeconds),
    pacePerKm: pace === null ? null : formatPace(pace),
    climbM: run.elevationGainM,
    descentM: run.elevationLossM ?? null,
    averageHr: run.averageHr ?? null,
    rpe: run.rpe ?? null,
    feel: run.feelScore ? feelLabel(run.feelScore) : null
  });
}

function wellnessSummary(day: CoachWellnessDay): Record<string, unknown> {
  return compact({
    date: day.date,
    sleepScore: day.sleepScore,
    sleepHours: day.sleepSeconds === null ? null : round1(day.sleepSeconds / 3600),
    hrvStatus: day.hrvStatus ? day.hrvStatus.toLowerCase() : null,
    hrvMs: day.hrvMs,
    bodyBattery: day.bodyBattery,
    trainingReadiness: day.trainingReadiness,
    restingHr: day.restingHr
  });
}

function exerciseName(exercise: string): string {
  switch (exercise) {
    case "pullUp": return "pull-ups";
    case "pushUp": return "push-ups";
    case "plank": return "plank";
    case "scapularPull": return "scapular pulls";
    case "hollowHold": return "hollow hold";
    case "inclinePushUp": return "incline push-ups";
    case "pikePushUp": return "pike push-ups";
    case "deadHang": return "dead hang";
    case "shoulderMobility": return "shoulder mobility";
    default: return humanize(exercise);
  }
}

function feelLabel(score: number): string {
  switch (Math.round(score)) {
    case 1: return "very weak";
    case 2: return "weak";
    case 3: return "normal";
    case 4: return "strong";
    case 5: return "very strong";
    default: return `${score}/5`;
  }
}

/** "Tue 2026-10-21" in the athlete's zone, so the model can say "Thursday". */
function dayLabel(date: Date, timeZone: string): string | null {
  if (!Number.isFinite(date.getTime())) return null;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  return `${weekday} ${dateOnlyFromDate(date, timeZone)}`;
}

function dateOnly(value: string, timeZone: string): string | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateOnlyFromDate(date, timeZone) : null;
}

function dateOnlyFromDate(date: Date, timeZone: string): string {
  const parts = localDateParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function formatDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatPace(secondsPerKm: number): string {
  const total = Math.round(secondsPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

/** Drops null, undefined, empty arrays and empty objects, at any depth, so the prompt stays small. */
function compact(value: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(value).flatMap(([key, item]): Array<[string, unknown]> => {
    const cleaned = isPlainObject(item) ? compact(item) : item;
    if (cleaned === null || cleaned === undefined) return [];
    if (Array.isArray(cleaned) && cleaned.length === 0) return [];
    if (isPlainObject(cleaned) && Object.keys(cleaned).length === 0) return [];
    return [[key, cleaned]];
  });
  return Object.fromEntries(entries);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
