import type { CoachContext, CoachEvaluation, CoachSnapshot, TrainingLog } from "./planner/types";
import type { TrainingSignals } from "./planner/compute-training-signals";

export type CoachChatRole = "user" | "coach";

export type CoachChatMessage = {
  role: CoachChatRole;
  text: string;
  createdAt?: string;
};

export const COACH_CHAT_MAX_MESSAGES = 20;
export const COACH_CHAT_MAX_TEXT_LENGTH = 1200;

export type CoachChatIntent =
  | "working"
  | "schedule"
  | "improvement"
  | "motivation"
  | "fatigue"
  | "pain"
  | "today"
  | "unsupported"
  | "general";

export type CoachChatResponse = {
  answer: string;
  evidence: string[];
  followUpPrompts: string[];
  memorySummary: string;
  contextState: CoachContext["readiness"]["state"];
  answerKind: CoachChatIntent;
  usedModel: false;
  generatedAt: string;
};

type BuildCoachChatInput = {
  messages: CoachChatMessage[];
  context: CoachContext;
  signals: TrainingSignals | null;
  evaluation: CoachEvaluation & { snapshot: CoachSnapshot };
  generatedAt?: Date;
};

type CoachChatFacts = {
  latestLog: TrainingLog | null;
  latestStrengthLine: string;
  latestPain: number | null;
  latestFatigue: number | null;
  maxRecentPain: number;
  maxRecentFatigue: number;
  adherenceLine: string;
  readinessLine: string;
  progressLine: string;
  planLine: string;
  raceLine: string | null;
  runningLine: string | null;
  todayLine: string | null;
  profileNotes: string;
};

export function normalizeCoachChatMessages(messages: CoachChatMessage[]): CoachChatMessage[] {
  const normalized = messages.map((message) => {
    const text = message.text.trim();
    if (text.length > COACH_CHAT_MAX_TEXT_LENGTH) {
      throw new Error(`chat message text must be ${COACH_CHAT_MAX_TEXT_LENGTH} characters or less`);
    }
    return {
      role: message.role,
      text,
      createdAt: message.createdAt
    };
  });

  if (!normalized.some((message) => message.role === "user")) {
    throw new Error("at least one user chat message is required");
  }

  return normalized.slice(-COACH_CHAT_MAX_MESSAGES);
}

export function buildCoachChatResponse(input: BuildCoachChatInput): CoachChatResponse {
  const messages = normalizeCoachChatMessages(input.messages);
  const question = latestUserQuestion(messages);
  const intent = classifyCoachChatQuestion(question);
  const facts = collectFacts(input.context, input.signals, input.evaluation);
  const memorySummary = summarizeEarlierQuestions(messages);
  const shouldUseMemoryPrefix = intent !== "general" && intent !== "motivation" && intent !== "unsupported";
  const memoryPrefix = shouldUseMemoryPrefix && memorySummary ? `${memorySummary}. Carrying that forward: ` : "";
  const answer = answerForIntent(intent, question, facts, input.evaluation, memoryPrefix);

  return {
    answer,
    evidence: evidenceForIntent(intent, facts),
    followUpPrompts: followUpsForIntent(intent),
    memorySummary,
    contextState: input.context.readiness.state,
    answerKind: intent,
    usedModel: false,
    generatedAt: (input.generatedAt ?? new Date()).toISOString()
  };
}

export function classifyCoachChatQuestion(question: string): CoachChatIntent {
  const text = question.toLowerCase();
  if (isUnsupportedQuestion(text)) {
    return "unsupported";
  }
  if (matchesAny(text, ["pain", "ache", "hurt", "sore", "injury", "knee", "shoulder", "ankle", "hip", "calf", "shin"])) {
    return "pain";
  }
  if (matchesAny(text, ["fatigue", "tired", "sleep", "recovery", "readiness", "hrv", "body battery"])) {
    return "fatigue";
  }
  if (matchesAny(text, ["schedule", "long-term", "long term", "goal", "race", "eiger", "ultra", "on pace"])) {
    return "schedule";
  }
  if (matchesAny(text, ["improve", "improvement", "weak point", "biggest point", "focus", "limiter", "better at"])) {
    return "improvement";
  }
  if (matchesAny(text, ["motivate", "motivation", "pep talk", "encourage", "encouragement", "hype me", "keep me going"])) {
    return "motivation";
  }
  if (matchesAny(text, ["today", "now", "next", "should i do"])) {
    return "today";
  }
  if (matchesAny(text, ["working well", "doing well", "on track", "am i good", "how am i doing", "work well"])) {
    return "working";
  }
  return "general";
}

function answerForIntent(
  intent: CoachChatIntent,
  question: string,
  facts: CoachChatFacts,
  evaluation: CoachEvaluation & { snapshot: CoachSnapshot },
  memoryPrefix: string
): string {
  switch (intent) {
    case "working":
      return [
        `${memoryPrefix}Yes, broadly you are working well.`,
        `${facts.adherenceLine} ${facts.latestStrengthLine}`,
        `${facts.readinessLine} The practical move is simple: ${evaluation.nextAction}`
      ].join(" ");
    case "schedule":
      return [
        `${memoryPrefix}You look on schedule, with one important caveat: the long-term goal is still mostly a running-readiness problem.`,
        facts.raceLine ?? "I do not have a race goal in the current context.",
        facts.runningLine ?? "I do not have enough recent running data to judge the endurance side cleanly.",
        `Keep the current structure unless recovery signs rise. ${facts.planLine}`
      ].join(" ");
    case "improvement":
      return [
        `${memoryPrefix}Your biggest improvement point is not doing more random work; it is making the next useful progression visible while protecting recovery.`,
        facts.runningLine
          ? `For the ultra, that means long-run progression and enough easy volume. ${facts.runningLine}`
          : `For strength, that means progressing the repeated goal work rather than adding noise. ${facts.progressLine}`,
        `Next step: ${evaluation.nextAction}`
      ].join(" ");
    case "motivation":
      return motivationAnswer(facts, evaluation);
    case "fatigue":
      return [
        `${memoryPrefix}Fatigue is worth watching, but I would not call it a red-alert from this data alone.`,
        `Latest logged fatigue is ${facts.latestFatigue ?? "unknown"}/10 and the highest recent fatigue is ${facts.maxRecentFatigue}/10.`,
        `${facts.readinessLine} If that tired feeling climbs or your session effort keeps landing above plan, cap intensity before adding volume.`
      ].join(" ");
    case "pain":
      return painAnswer(question, facts, evaluation, memoryPrefix);
    case "today":
      return [
        facts.todayLine
          ? `${memoryPrefix}For today, follow the current plan rather than improvising.`
          : `${memoryPrefix}For today, do not add extra work.`,
        facts.todayLine ?? "I do not see a planned session today.",
        `${facts.readinessLine} Next step: ${evaluation.nextAction}`
      ].join(" ");
    case "unsupported":
      return [
        "I can answer coach questions from your Lockin training data, but I do not have live weather, web lookup, or general chat tools in this chat yet.",
        "Ask me about today's training, your schedule, fatigue, pain, readiness, or your biggest improvement point and I can be specific."
      ].join(" ");
    case "general":
      return [
        `${memoryPrefix}The clean read is: ${evaluation.statusLabel.toLowerCase()}.`,
        `${facts.adherenceLine} ${facts.readinessLine}`,
        `Ask me about schedule, fatigue, pain, today's session, or your biggest improvement point and I can be more specific.`
      ].join(" ");
  }
}

function painAnswer(
  question: string,
  facts: CoachChatFacts,
  evaluation: CoachEvaluation & { snapshot: CoachSnapshot },
  memoryPrefix: string
): string {
  const bodyPart = bodyPartFromQuestion(question);
  const area = bodyPart ? `your ${bodyPart}` : "that area";
  const note = facts.profileNotes ? ` Your profile note says: ${facts.profileNotes}` : "";

  return [
    `${memoryPrefix}For ${area}, treat this as a training signal, not a diagnosis.`,
    `The log shows recent pain up to ${facts.maxRecentPain}/10 and the latest logged pain is ${facts.latestPain ?? "unknown"}/10.${note}`,
    `Do not push through sharp, worsening, limping, swollen, numb, or movement-changing pain. If it behaves like that, stop and get medical help.`,
    `Training-wise: keep the next step conservative. ${evaluation.nextAction}`
  ].join(" ");
}

function motivationAnswer(
  facts: CoachChatFacts,
  evaluation: CoachEvaluation & { snapshot: CoachSnapshot }
): string {
  const consistencyLine = motivationalConsistencyLine(evaluation);
  const progressLine = motivationalProgressLine(evaluation);
  const effortLine = motivationalEffortLine(facts);
  const cautionLine = evaluation.readiness.state === "recovery_needed" || evaluation.readiness.state === "overreaching"
    ? "Today, being disciplined may mean holding back a little, not proving toughness."
    : "Do the next planned thing cleanly; that is enough for today.";

  return [
    "Yes. Keep going.",
    consistencyLine,
    progressLine,
    effortLine,
    cautionLine,
    "You do not need a heroic session right now. You need one more honest rep, one more honest run, one more logged result."
  ].join(" ");
}

function motivationalConsistencyLine(evaluation: CoachEvaluation & { snapshot: CoachSnapshot }): string {
  const completed = evaluation.adherence.completedSessions;
  const due = evaluation.adherence.dueSessions;
  if (evaluation.adherence.completedPct === null || due === 0) {
    return "There is not much due work to judge yet, so the win is simple: start the next session and make it count.";
  }
  if (evaluation.adherence.completedPct >= evaluation.adherence.standardPct) {
    return `You are showing up: ${completed} of ${due} due sessions are done, which is exactly the kind of consistency this goal needs.`;
  }
  return `You are not out of this. ${completed} of ${due} due sessions are done, and the fastest way back is one clean session, not panic-catching up.`;
}

function motivationalProgressLine(evaluation: CoachEvaluation & { snapshot: CoachSnapshot }): string {
  switch (evaluation.progress.state) {
    case "improving":
      return "Your recent trend is moving forward, so trust the boring work. It is doing something.";
    case "holding":
      return "The progress line is a bit flat, but that is not failure; it is feedback. Stay steady and make the next progression visible.";
    case "declining":
      return "The trend is not where we want it yet, but that is not a verdict on you. Simplify, recover where needed, and make the next session honest.";
    case "not_enough_data":
      return "There is not enough clean history to judge the trend yet, so do not argue with the whole future. Give yourself one good data point today.";
  }
}

function motivationalEffortLine(facts: CoachChatFacts): string {
  if (!facts.latestLog) {
    return "The first useful win is not complicated: begin, finish, and give yourself a real data point.";
  }
  return "The work is already on the board; now the job is to keep stacking it without making it dramatic.";
}

function collectFacts(
  context: CoachContext,
  signals: TrainingSignals | null,
  evaluation: CoachEvaluation & { snapshot: CoachSnapshot }
): CoachChatFacts {
  const latestLog = context.history.last5Logs.at(-1) ?? null;
  const maxRecentPain = Math.max(0, ...context.history.last5Logs.map((log) => log.painLevel ?? 0));
  const maxRecentFatigue = Math.max(0, ...context.history.last5Logs.map((log) => log.fatigueLevel ?? 0));
  const latestStrengthLine = latestLog
    ? `Latest strength log: ${latestLog.pullUps} pull-ups, ${latestLog.pushUps} push-ups, ${formatSeconds(latestLog.plankSeconds)} plank, RPE ${latestLog.rpe}.`
    : "I do not have a completed strength log yet.";
  const adherenceLine = evaluation.adherence.completedPct === null
    ? "Adherence is not scored yet because no sessions are due."
    : `Adherence is ${evaluation.adherence.completedPct}% against the ${evaluation.adherence.standardPct}% standard.`;
  const readinessLine = `Readiness is ${humanize(evaluation.readiness.state)}. ${evaluation.readiness.rationale}`;
  const progressLine = `Progress is ${humanize(evaluation.progress.state)}. ${evaluation.progress.rationale}`;
  const planLine = `Plan decision: ${humanize(evaluation.planDecision.action)}. ${evaluation.planDecision.rationale}`;
  const raceLine = context.running
    ? `${context.running.raceGoal.name}: ${context.running.weeksToRace} weeks out for ${context.running.raceGoal.distanceKm} km and ${context.running.raceGoal.elevationGainM} m+.`
    : null;
  const runningLine = signals
    ? `Running: ${signals.running.last7DaysKm} km in the last 7 days, longest recent run ${signals.running.longestRunLast6WeeksKm} km.`
    : null;
  const todayLine = context.plannedWork.todaySessions.length > 0
    ? `Today has ${context.plannedWork.todaySessions.map((session) => session.title).join(" and ")} on the plan.`
    : null;

  return {
    latestLog,
    latestStrengthLine,
    latestPain: latestLog?.painLevel ?? null,
    latestFatigue: latestLog?.fatigueLevel ?? null,
    maxRecentPain,
    maxRecentFatigue,
    adherenceLine,
    readinessLine,
    progressLine,
    planLine,
    raceLine,
    runningLine,
    todayLine,
    profileNotes: context.profile.profileNotes
  };
}

function evidenceForIntent(intent: CoachChatIntent, facts: CoachChatFacts): string[] {
  if (intent === "unsupported") {
    return [];
  }
  if (intent === "motivation") {
    return [];
  }

  const evidence = [
    facts.adherenceLine,
    facts.readinessLine,
    facts.raceLine,
    facts.runningLine,
    facts.latestStrengthLine
  ].filter((item): item is string => Boolean(item));

  if (intent === "pain") {
    evidence.unshift(`Recent pain up to ${facts.maxRecentPain}/10`);
  }
  if (intent === "fatigue") {
    evidence.unshift(`Recent fatigue up to ${facts.maxRecentFatigue}/10`);
  }

  return [...new Set(evidence)].slice(0, 5);
}

function followUpsForIntent(intent: CoachChatIntent): string[] {
  switch (intent) {
    case "working":
      return ["What is my biggest improvement point?", "Am I on schedule for the race?"];
    case "schedule":
      return ["What should I protect this week?", "What is the long-run gap?"];
    case "improvement":
      return ["What should I change today?", "How do I progress safely?"];
    case "motivation":
      return ["What should I do today?", "What should I protect this week?"];
    case "fatigue":
      return ["Should I reduce intensity today?", "What fatigue sign matters most?"];
    case "pain":
      return ["Should I skip today's session?", "What can I train around safely?"];
    case "today":
      return ["What should I watch during it?", "How hard should it feel?"];
    case "unsupported":
      return ["What should I do today?", "What can you say about fatigue?"];
    case "general":
      return ["Am I working well?", "What can you say about fatigue?"];
  }
}

function latestUserQuestion(messages: CoachChatMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.text.trim() ?? "";
}

function summarizeEarlierQuestions(messages: CoachChatMessage[]): string {
  const userQuestions = messages
    .filter((message) => message.role === "user")
    .map((message) => message.text.trim())
    .filter(Boolean);
  const earlier = userQuestions.slice(0, -1);
  if (earlier.length === 0) {
    return "";
  }

  const labels = earlier
    .map((question) => classifyCoachChatQuestion(question))
    .filter((intent) => intent !== "general" && intent !== "unsupported")
    .map((intent) => labelForIntent(intent));
  const uniqueLabels = [...new Set(labels)].slice(-3);
  if (uniqueLabels.length === 0) {
    return "";
  }
  return `Earlier you asked about ${joinHuman(uniqueLabels)}`;
}

function labelForIntent(intent: CoachChatIntent): string {
  switch (intent) {
    case "working": return "whether your work is on track";
    case "schedule": return "your long-term schedule";
    case "improvement": return "your biggest improvement point";
    case "motivation": return "motivation";
    case "fatigue": return "fatigue";
    case "pain": return "pain";
    case "today": return "today's next step";
    case "unsupported": return "unsupported questions";
    case "general": return "your training state";
  }
}

function isUnsupportedQuestion(text: string): boolean {
  if (matchesAny(text, ["weather", "temperature", "rain", "wind", "forecast"])) {
    return true;
  }

  const normalized = text
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ["test", "ok", "okay", "hi", "hello", "hey", "thanks", "thank you"].includes(normalized);
}

function bodyPartFromQuestion(question: string): string | null {
  const text = question.toLowerCase();
  for (const part of ["shoulder", "knee", "ankle", "hip", "calf", "shin", "back", "elbow", "foot"]) {
    if (text.includes(part)) return part;
  }
  return null;
}

function matchesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.max(0, seconds - minutes * 60);
  if (minutes <= 0) return `${remainder}s`;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function joinHuman(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}
