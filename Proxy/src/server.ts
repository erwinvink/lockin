import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCoachContext } from "./coach/planner/build-coach-context";
import { withStoredCurrentPlan } from "./coach/planner/current-plan";
import { EXERCISE_KINDS, schemaForExercises } from "./coach/planner/exercise-catalog";
import {
  disciplineCoachSystemPrompt,
  disciplineCoachTemperament,
  flatGoalMetricsRequiringProgression
} from "./coach/planner/coach-temperament";
import { coachReferencePoints, computeTrainingSignals } from "./coach/planner/compute-training-signals";
import { runningDayAvailability } from "./coach/planner/validate-running-week";
import {
  runCombinedWeekPipeline,
  runStrengthWeekPipeline,
  type CombinedPipelineDeps,
  type Generated,
  type PipelineFailure,
  type PlannedRunSummary,
  type RunningPlannerGuidance,
  type StrengthPlannerGuidance
} from "./coach/plan-pipeline";
import { evaluateCoachRead } from "./coach/planner/evaluate-coach-read";
import { normalizeCoachVerdict } from "./coach/planner/normalize-coach-verdict";
import type { CoachContext, CoachEvaluation, CoachRequest, CoachSnapshot, CoachVerdict, RunningWeek, WeeklyPlan } from "./coach/planner/types";
import type { TrainingSignals } from "./coach/planner/compute-training-signals";
import {
  AutoPlanStore,
  markAutoPlanFailed,
  markAutoPlanGenerated,
  prepareAutoPlanTrigger,
  runDueAutoPlans,
  toAutoPlanStatus,
  type AutoPlanGeneratedPlan,
  type AutoPlanSource,
  type AutoPlanTrigger
} from "./coach/auto-plan";
import { answerCoachChat, type CoachChatModelCall } from "./coach/chat-model";
import { assertCoachRequestShape, buildCoachContextFromClient, parseCoachChatPayload, parseCoachRequestBody } from "./coach/chat-request";
import { appTokenFromEnv, isAuthorizedAppRequest } from "./app-auth";
import { createGarminEnricher } from "./garmin/garmin-enrichment";
import { createGarminRouteHandler } from "./garmin/garmin-routes";
import { GarminSyncInputError } from "./garmin/garmin-sync";
import { GarminSyncStore } from "./garmin/garmin-sync-store";
import { defaultCoachModel, filterAllowedModels, pickTextModelIDs, resolveCoachModel, withDefaultCoachModel } from "./model-selection";
import { ClientInputError, errorResponseFor, parseJSONBody, parseJSONObjectBody, readRequestBody, RequestBodyTooLargeError } from "./http-body";
import { fetchOpenAIResponse, recordCoachValidationFailure, type OpenAIRequestTelemetry } from "./openai-telemetry";
import { createLockinApiHandler } from "./storage/lockin-api";
import { LockinStore } from "./storage/lockin-store";

const port = Number(process.env.PORT ?? 8787);
const apiKey = process.env.OPENAI_API_KEY;
const skillRoot = join(process.cwd(), "src", "coach", "skills", "fitness-coach-planner");
const runningSkillRoot = join(process.cwd(), "src", "coach", "skills", "running-coach-planner");
const garminSyncStore = new GarminSyncStore();
const autoPlanStore = new AutoPlanStore();
const lockinStore = new LockinStore();
const handleLockinApi = createLockinApiHandler(lockinStore);
const handleGarminRoutes = createGarminRouteHandler({ syncStore: garminSyncStore });
const enrichWithGarmin = createGarminEnricher();
const appToken = appTokenFromEnv(process.env);
if (!appToken) {
  console.warn("LOCKIN_APP_TOKEN is not set: every proxy route is open to anyone who can reach this server.");
}

createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
  });
  try {
    if (!isAuthorizedAppRequest(req, appToken)) {
      writeJSON(res, 401, { error: "missing or invalid app token" });
      return;
    }

    if (await handleLockinApi(req, res)) {
      return;
    }

    if (await handleGarminRoutes(req, res)) {
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      writeJSON(res, 200, { ok: true, hasApiKey: Boolean(apiKey), defaultModel: defaultCoachModel });
      return;
    }

    if (req.method === "GET" && req.url === "/models") {
      if (!apiKey) {
        writeJSON(res, 500, { error: "OPENAI_API_KEY is not set" });
        return;
      }

      writeJSON(res, 200, {
        defaultModel: defaultCoachModel,
        models: await fetchAvailableModels(apiKey)
      });
      return;
    }

    if (req.method === "GET" && req.url?.split("?")[0] === "/plan/status") {
      const userId = queryValue(req.url, "userId");
      if (!userId) {
        writeJSON(res, 400, { error: "userId is required" });
        return;
      }
      const state = await autoPlanStore.read();
      writeJSON(res, 200, toAutoPlanStatus(state.users[userId] ?? null, userId));
      return;
    }

    if (req.method === "POST" && req.url === "/plan/trigger") {
      writeJSON(res, 200, await runAutoPlanTrigger(parseAutoPlanTrigger(parseJSONObjectBody(await readBody(req)))));
      return;
    }

    if (req.method === "POST" && req.url === "/coach-verdict") {
      if (!apiKey) {
        writeJSON(res, 500, { error: "OPENAI_API_KEY is not set" });
        return;
      }

      const payload = parseCoachRequestBody(await readBody(req));
      const model = resolveCoachModel(payload.model);

      const context = await enrichWithGarmin(buildCoachContextFromClient(payload), payload.userId);
      const trainingSignals = computeTrainingSignals(context);
      const evaluation = evaluateCoachRead(context, trainingSignals);
      const generated = await generateCoachVerdict(
        apiKey,
        model,
        context,
        trainingSignals,
        evaluation,
        coachTelemetry(payload, model, "/coach-verdict", "coach_verdict", context)
      );

      if (!generated.ok) {
        res.writeHead(generated.status, { "content-type": "application/json" }).end(generated.body);
        return;
      }

      writeJSON(res, 200, normalizeCoachVerdict(generated.verdict, context, evaluation));
      return;
    }

    if (req.method === "POST" && req.url === "/coach-chat") {
      const chatPayload = parseCoachChatPayload(parseJSONBody(await readBody(req)));
      const payload = chatPayload.request;
      const model = resolveCoachModel(payload.model);

      const context = await enrichWithGarmin(buildCoachContextFromClient(payload), payload.userId);
      const trainingSignals = computeTrainingSignals(context);
      const evaluation = evaluateCoachRead(context, trainingSignals);
      writeJSON(res, 200, await answerCoachChat({
        messages: chatPayload.messages,
        context,
        signals: trainingSignals,
        evaluation,
        request: payload,
        model,
        callModel: apiKey
          ? coachChatModelCaller(apiKey, coachTelemetry(payload, model, "/coach-chat", "coach_chat", context))
          : null,
        onFallback: (reason, details) => {
          console.warn(`coach_chat.fallback ${JSON.stringify({ reason, model, ...details })}`);
        }
      }));
      return;
    }

    if (req.method === "POST" && req.url === "/generate-week") {
      if (!apiKey) {
        writeJSON(res, 500, { error: "OPENAI_API_KEY is not set" });
        return;
      }

      const payload = parseCoachRequestBody(await readBody(req));
      const model = resolveCoachModel(payload.model);

      if (!payload.running) {
        writeJSON(res, 400, { error: "running goal is required for /generate-week" });
        return;
      }

      if (Number.isNaN(Date.parse(payload.running.raceGoal?.raceDate))) {
        writeJSON(res, 400, { error: "running raceGoal.raceDate must be an ISO-8601 date" });
        return;
      }

      const [skill, runningSkill] = await Promise.all([loadSkillBundle(), loadRunningSkillBundle()]);
      const context = await enrichWithGarmin(buildCoachContextFromClient(payload), payload.userId);

      const result = await runCombinedWeekPipeline(
        combinedPipelineDeps(apiKey, model, skill, runningSkill, context, payload, "/generate-week")
      );
      if (!result.ok) {
        writePipelineFailure(res, result, context);
        return;
      }

      logPlanAdjustments("/generate-week", result.adjustments, result.repairs);
      writeJSON(res, 200, {
        summary: `${result.runningWeek.summary} ${result.strengthWeek.summary}`,
        safetyFlags: [...new Set([...result.runningWeek.safetyFlags, ...result.strengthWeek.safetyFlags])],
        runningWeek: result.runningWeek,
        strengthWeek: result.strengthWeek,
        adjustments: result.adjustments
      });
      return;
    }

    if (req.method !== "POST" || req.url !== "/generate-week-plan") {
      res.writeHead(404).end("Not found");
      return;
    }

    if (!apiKey) {
      writeJSON(res, 500, { error: "OPENAI_API_KEY is not set" });
      return;
    }

    const payload = parseCoachRequestBody(await readBody(req));
    const model = resolveCoachModel(payload.model);

    const skill = await loadSkillBundle();
    const context = buildCoachContextFromClient(payload);

    const generated = await generateStrengthOnlyResponse(apiKey, model, skill, context, payload, "/generate-week-plan");
    if (!generated.ok) {
      res.writeHead(generated.status, { "content-type": "application/json" }).end(generated.body);
      return;
    }

    res.writeHead(200, { "content-type": "application/json" }).end(generated.outputText);
  } catch (error) {
    if (error instanceof GarminSyncInputError) {
      writeJSON(res, 400, { error: error.message });
      return;
    }
    const response = errorResponseFor(error, isClientInputError);
    if (response.status >= 500) {
      console.error(`${req.method} ${req.url} failed:`, error);
    }
    if (error instanceof RequestBodyTooLargeError) {
      // The rest of the body is not read; close instead of reusing the connection.
      res.setHeader("connection", "close");
    }
    writeJSON(res, response.status, response.body);
  }
}).listen(port, () => {
  console.log(`Fitness coach proxy listening on port ${port}`);
});
startAutoPlanScheduler();

type SkillBundle = {
  instructions: string;
  progressionPolicy: string;
  realWorldStandards: string;
  exerciseLibrary: string;
  weeklyPlanSchema: Record<string, unknown>;
};

type RunningSkillBundle = {
  instructions: string;
  ultraPeriodization: string;
  runningWeekSchema: Record<string, unknown>;
};

type RepairInput = {
  messages: string[];
  previousPlan: WeeklyPlan;
};

type RunningRepairInput = {
  messages: string[];
  previousPlan: RunningWeek;
};

type GenerateResult =
  | { ok: true; outputText: string; plan: WeeklyPlan }
  | { ok: false; status: number; body: string };

type RunningGenerateResult =
  | { ok: true; outputText: string; week: RunningWeek }
  | { ok: false; status: number; body: string };

type VerdictResult =
  | { ok: true; verdict: CoachVerdict }
  | { ok: false; status: number; body: string };

type AutoPlanTriggerResponse = {
  userId: string;
  status: string;
  action: string;
  message: string;
  source: AutoPlanSource | null;
  lastGeneratedAt: string | null;
  nextNightlyRunAt: string | null;
  nextRetryAt: string | null;
  planRevisionId: string | null;
  generatedPlan: AutoPlanGeneratedPlan | null;
  generated: boolean;
  strengthWeek?: WeeklyPlan;
  runningWeek?: RunningWeek;
  combinedWeek?: {
    summary: string;
    safetyFlags: string[];
    runningWeek: RunningWeek;
    strengthWeek: WeeklyPlan;
  };
};

const coachVerdictSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "headline",
    "summary",
    "latestChange",
    "recommendation",
    "runningRead",
    "strengthRead",
    "nextStep",
    "watchItems",
    "shouldUpdatePlan",
    "contextState",
    "safetyFlags"
  ],
  properties: {
    headline: { type: "string" },
    summary: { type: "string" },
    latestChange: { type: "string" },
    recommendation: { type: "string" },
    runningRead: { type: "string" },
    strengthRead: { type: "string" },
    nextStep: { type: "string" },
    watchItems: {
      type: "array",
      items: { type: "string" }
    },
    shouldUpdatePlan: { type: "boolean" },
    contextState: {
      enum: ["building", "plateau", "overreaching", "recovery_needed", "insufficient_history"]
    },
    safetyFlags: {
      type: "array",
      items: { type: "string" }
    }
  }
} satisfies Record<string, unknown>;

async function runAutoPlanTrigger(trigger: AutoPlanTrigger): Promise<AutoPlanTriggerResponse> {
  const userId = cleanString(trigger.request.userId);
  if (!userId) {
    throw new Error("request.userId is required");
  }

  const decision = await autoPlanStore.updateUser(userId, (user) => {
    return prepareAutoPlanTrigger(user, trigger, autoPlanStore.now());
  });

  if (decision.action !== "generate") {
    const state = await autoPlanStore.read();
    const status = toAutoPlanStatus(state.users[userId] ?? null, userId);
    return {
      ...status,
      action: decision.action,
      generated: false,
      generatedPlan: decision.generatedPlan ?? status.generatedPlan
    };
  }

  try {
    // The previous generated plan may be newer than what the app applied
    // (nightly runs reuse the last request the app sent): keep that one.
    const generated = await generateAutoPlan(trigger.request, decision.generatedPlan ?? null);
    const plan = await autoPlanStore.updateUser(userId, (user) => {
      return markAutoPlanGenerated(user, decision, generated);
    });
    const state = await autoPlanStore.read();
    const status = toAutoPlanStatus(state.users[userId] ?? null, userId);
    return {
      ...status,
      action: decision.action,
      message: decision.message,
      generated: true,
      generatedPlan: plan,
      strengthWeek: plan.strengthWeek,
      runningWeek: plan.runningWeek,
      combinedWeek: plan.combinedWeek
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Automatic planning failed.";
    await autoPlanStore.updateUser(userId, (user) => {
      markAutoPlanFailed(user, message, autoPlanStore.now());
    });
    throw error;
  }
}

async function generateAutoPlan(
  payload: CoachRequest,
  storedPlan: AutoPlanGeneratedPlan | null = null
): Promise<Omit<AutoPlanGeneratedPlan, "planRevisionId" | "generatedAt" | "localDate" | "source">> {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const model = resolveCoachModel(payload.model);

  const skill = await loadSkillBundle();
  const now = new Date();
  const context = withStoredCurrentPlan(await enrichWithGarmin(buildCoachContext(payload, now), payload.userId), payload, storedPlan, now);

  if (!payload.running) {
    const result = await runStrengthWeekPipeline(strengthPipelineDeps(apiKey, model, skill, context, payload, "/plan/trigger"));
    if (!result.ok) {
      throw new Error(pipelineFailureMessage(result));
    }
    logPlanAdjustments("/plan/trigger", result.adjustments, result.repairs);
    const strengthWeek = result.strengthWeek;

    return {
      weekStart: payload.weekStart,
      summary: strengthWeek.summary,
      strengthWeek
    };
  }

  if (Number.isNaN(Date.parse(payload.running.raceGoal?.raceDate))) {
    throw new Error("running raceGoal.raceDate must be an ISO-8601 date");
  }

  const runningSkill = await loadRunningSkillBundle();
  const result = await runCombinedWeekPipeline(
    combinedPipelineDeps(apiKey, model, skill, runningSkill, context, payload, "/plan/trigger")
  );
  if (!result.ok) {
    throw new Error(pipelineFailureMessage(result));
  }
  logPlanAdjustments("/plan/trigger", result.adjustments, result.repairs);
  const { runningWeek, strengthWeek } = result;

  const combinedWeek = {
    summary: `${runningWeek.summary} ${strengthWeek.summary}`,
    safetyFlags: [...new Set([...runningWeek.safetyFlags, ...strengthWeek.safetyFlags])],
    runningWeek,
    strengthWeek
  };

  return {
    weekStart: payload.weekStart,
    summary: combinedWeek.summary,
    runningWeek,
    strengthWeek,
    combinedWeek
  };
}

function combinedPipelineDeps(
  apiKey: string,
  model: string,
  skill: SkillBundle,
  runningSkill: RunningSkillBundle,
  context: CoachContext,
  payload: CoachRequest,
  route: string
): CombinedPipelineDeps {
  return {
    ...strengthPipelineDeps(apiKey, model, skill, context, payload, route),
    generateRunning: async (guidance, repair) =>
      toGenerated(
        await generateRunningWeek(
          apiKey,
          model,
          runningSkill,
          context,
          coachTelemetry(payload, model, route, repair ? "running_repair" : "running_initial", context, Boolean(repair)),
          repair,
          guidance
        ),
        (result) => result.week
      )
  };
}

function strengthPipelineDeps(
  apiKey: string,
  model: string,
  skill: SkillBundle,
  context: CoachContext,
  payload: CoachRequest,
  route: string
): Omit<CombinedPipelineDeps, "generateRunning"> {
  return {
    context,
    generateStrength: async (guidance, repair) =>
      toGenerated(
        await generateWeeklyPlan(
          apiKey,
          model,
          skill,
          context,
          coachTelemetry(payload, model, route, repair ? "strength_repair" : "strength_initial", context, Boolean(repair)),
          repair,
          guidance.plannedRuns,
          guidance
        ),
        (result) => result.plan
      ),
    recordValidationFailure: (phase, messages, repairAttempt) =>
      recordCoachValidationFailure(coachTelemetry(payload, model, route, phase, context, repairAttempt), messages)
  };
}

async function generateStrengthOnlyResponse(
  apiKey: string,
  model: string,
  skill: SkillBundle,
  context: CoachContext,
  payload: CoachRequest,
  route: string
): Promise<{ ok: true; outputText: string } | { ok: false; status: number; body: string }> {
  const result = await runStrengthWeekPipeline(strengthPipelineDeps(apiKey, model, skill, context, payload, route));
  if (!result.ok) {
    return result.reason === "upstream"
      ? { ok: false, status: result.status, body: result.body }
      : { ok: false, status: 422, body: JSON.stringify(pipelineFailureBody(result, context)) };
  }
  logPlanAdjustments(route, result.adjustments, result.repairs);
  return { ok: true, outputText: JSON.stringify(result.strengthWeek) };
}

function toGenerated<R extends { ok: true } | { ok: false; status: number; body: string }, T>(
  result: R,
  pick: (result: Extract<R, { ok: true }>) => T
): Generated<T> {
  return result.ok
    ? { ok: true, value: pick(result as Extract<R, { ok: true }>) }
    : { ok: false, status: (result as { status: number }).status, body: (result as { body: string }).body };
}

function pipelineFailureBody(failure: Extract<PipelineFailure, { reason: "validation" }>, context: CoachContext) {
  return {
    error:
      failure.stage === "running"
        ? "Generated running week failed validation after one repair attempt."
        : "Generated plan failed technical validation after one repair attempt.",
    messages: failure.messages,
    firstAttemptMessages: failure.firstAttemptMessages,
    contextState: context.readiness.state
  };
}

function writePipelineFailure(res: ServerResponse, failure: PipelineFailure, context: CoachContext) {
  if (failure.reason === "upstream") {
    res.writeHead(failure.status, { "content-type": "application/json" }).end(failure.body);
    return;
  }
  writeJSON(res, 422, pipelineFailureBody(failure, context));
}

function pipelineFailureMessage(failure: PipelineFailure): string {
  if (failure.reason === "upstream") return failure.body;
  const subject = failure.stage === "running" ? "Generated running week failed validation" : "Generated plan failed technical validation";
  return `${subject} after one repair attempt: ${failure.messages.join(" ")}`;
}

function logPlanAdjustments(route: string, adjustments: string[], repairs: number) {
  if (adjustments.length === 0 && repairs === 0) return;
  console.log(`${route} plan guardrails: ${repairs} repair attempt(s), ${adjustments.length} clamp adjustment(s).`);
  for (const adjustment of adjustments) {
    console.log(`  - ${adjustment}`);
  }
}

function parseAutoPlanTrigger(payload: Record<string, unknown>): AutoPlanTrigger {
  const source = autoPlanSource(payload.source);
  const request = payload.request;
  if (!isRecord(request)) {
    throw new ClientInputError("request object is required");
  }
  // A malformed request would otherwise be stored and fail every night.
  assertCoachRequestShape(request);
  return {
    source,
    request: request as CoachRequest,
    force: payload.force === true,
    reason: cleanString(payload.reason),
    timeZone: cleanString(payload.timeZone)
  };
}

function startAutoPlanScheduler(): void {
  if (process.env.AUTO_PLANNER_DISABLED === "1") {
    return;
  }
  const intervalMs = Math.max(60_000, Number(process.env.AUTO_PLANNER_INTERVAL_MS ?? 15 * 60_000));
  const timer = setInterval(() => {
    // runDueAutoPlans logs its own failures; the catch is a last line of
    // defence so a rejected tick can never take the whole proxy down.
    runDueAutoPlans({ store: autoPlanStore, runTrigger: runAutoPlanTrigger }).catch((error: unknown) => {
      console.error("Auto plan scheduler tick failed:", error);
    });
  }, intervalMs);
  timer.unref();
}

async function loadSkillBundle(): Promise<SkillBundle> {
  const [instructions, progressionPolicy, realWorldStandards, exerciseLibrary, weeklyPlanSchemaRaw] = await Promise.all([
    readFile(join(skillRoot, "SKILL.md"), "utf8"),
    readFile(join(skillRoot, "references", "progression-policy.md"), "utf8"),
    readFile(join(skillRoot, "references", "real-world-standards.md"), "utf8"),
    readFile(join(skillRoot, "references", "exercise-library.json"), "utf8"),
    readFile(join(skillRoot, "references", "weekly-plan.schema.json"), "utf8")
  ]);

  return {
    instructions,
    progressionPolicy,
    realWorldStandards,
    exerciseLibrary,
    weeklyPlanSchema: JSON.parse(weeklyPlanSchemaRaw) as Record<string, unknown>
  };
}

async function loadRunningSkillBundle(): Promise<RunningSkillBundle> {
  const [instructions, ultraPeriodization, runningWeekSchemaRaw] = await Promise.all([
    readFile(join(runningSkillRoot, "SKILL.md"), "utf8"),
    readFile(join(runningSkillRoot, "references", "ultra-periodization.md"), "utf8"),
    readFile(join(runningSkillRoot, "references", "running-week.schema.json"), "utf8")
  ]);

  return {
    instructions,
    ultraPeriodization,
    runningWeekSchema: JSON.parse(runningWeekSchemaRaw) as Record<string, unknown>
  };
}

async function generateWeeklyPlan(
  apiKey: string,
  model: string,
  skill: SkillBundle,
  context: CoachContext,
  telemetry: OpenAIRequestTelemetry,
  repair?: RepairInput,
  plannedRuns?: PlannedRunSummary[],
  guidance?: StrengthPlannerGuidance
): Promise<GenerateResult> {
  const response = await fetchOpenAIResponse(apiKey, {
    model,
    input: [
      {
        role: "system",
        content: [
          "You are executing the following Agent Skill. Follow it exactly.",
          skill.instructions,
          "Reference: progression-policy.md",
          skill.progressionPolicy,
          "Reference: real-world-standards.md",
          skill.realWorldStandards,
          "Reference: exercise-library.json",
          skill.exerciseLibrary
        ].join("\n\n")
      },
      {
        role: "user",
        content: JSON.stringify(buildCoachPromptPayload(context, repair, plannedRuns, guidance))
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "weekly_training_plan",
        strict: true,
        schema: schemaForExercises(skill.weeklyPlanSchema, context.profile.supportedExercises ?? EXERCISE_KINDS)
      }
    }
  }, telemetry);

  if (!response.ok) {
    return { ok: false, status: response.status, body: response.body };
  }

  const outputText = extractOutputText(response.json);
  return { ok: true, outputText, plan: JSON.parse(outputText) as WeeklyPlan };
}

async function generateRunningWeek(
  apiKey: string,
  model: string,
  skill: RunningSkillBundle,
  context: CoachContext,
  telemetry: OpenAIRequestTelemetry,
  repair?: RunningRepairInput,
  guidance?: RunningPlannerGuidance
): Promise<RunningGenerateResult> {
  const response = await fetchOpenAIResponse(apiKey, {
    model,
    input: [
      {
        role: "system",
        content: [
          "You are executing the following Agent Skill. Follow it exactly.",
          skill.instructions,
          "Reference: ultra-periodization.md",
          skill.ultraPeriodization
        ].join("\n\n")
      },
      {
        role: "user",
        content: JSON.stringify(buildRunningPromptPayload(context, repair, guidance))
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "running_week_plan",
        strict: true,
        schema: skill.runningWeekSchema
      }
    }
  }, telemetry);

  if (!response.ok) {
    return { ok: false, status: response.status, body: response.body };
  }

  const outputText = extractOutputText(response.json);
  return { ok: true, outputText, week: JSON.parse(outputText) as RunningWeek };
}

function buildRunningPromptPayload(
  context: CoachContext,
  repair?: RunningRepairInput,
  guidance?: RunningPlannerGuidance
): Record<string, unknown> {
  const availability = runningDayAvailability(context);
  const basePayload = {
    coachContext: context,
    trainingSignals: guidance?.trainingSignals ?? null,
    outputRules: {
      guardrails: guidance?.guardrails ?? null,
      guardrailRule:
        "guardrails are computed by code and enforced after you answer: weekly km cap, long-run cap, run-count floor, hard-run cap and spacing, and plausible targets. Plan inside them; safety flags never waive them. Base volume decisions on trainingSignals and guardrails, not on arithmetic over recentRuns.",
      todayIsLocked: true,
      availableRunningDays: context.running?.runningDays ?? [],
      unconstrainedRunningDays: availability.unconstrained,
      availableDayOffsets: availability.offsets,
      scheduling: availability.unconstrained
        ? "No running days are selected, so any dayOffset 1 through 6 is available. Plan a normal week and keep one complete rest day."
        : availability.offsets.length === 0
          ? "None of the selected running days is left this week. Return zero runs and explain that the next full week starts after the coming rest days."
          : "Use only availableDayOffsets for runs.",
      longRunDay: context.running?.longRunDay ?? null,
      longRunDayOffset: context.running?.longRunDayOffset ?? null,
      ...(guidance?.continuity ? { continuity: guidance.continuity } : {})
    }
  };

  if (!repair) {
    return basePayload;
  }

  return {
    ...basePayload,
    repairRequest: {
      instruction:
        "The previous plan failed technical validation. Repair it once by changing only what is needed, then return schema-valid JSON only.",
      validationMessages: repair.messages,
      previousPlan: repair.previousPlan
    }
  };
}

async function generateCoachVerdict(
  apiKey: string,
  model: string,
  context: CoachContext,
  trainingSignals: TrainingSignals | null,
  coachEvaluation: CoachEvaluation & { snapshot: CoachSnapshot },
  telemetry: OpenAIRequestTelemetry
): Promise<VerdictResult> {
  const isHybrid = Boolean(context.running);
  const response = await fetchOpenAIResponse(apiKey, {
    model,
    input: [
      {
        role: "system",
        content: [
          "You are a human, athlete-facing training coach inside lockin.",
          disciplineCoachSystemPrompt,
          isHybrid
            ? "Write like an experienced ultra-endurance coach who also programs strength: direct, calm, practical, and not technical. Running volume, the long run, descent exposure, and the race countdown lead the read; strength work is framed as serving the race (running economy, durability), never as a separate hobby."
            : "Write like an experienced strength coach: direct, calm, practical, and not technical.",
          "Return a short read on the athlete's current state. This is shown directly to the athlete, not to a developer.",
          "Separate running and strength clearly. runningRead is only running/endurance/race-readiness. strengthRead is only strength, mobility, pain, fatigue, or durability work. If one side has no real signal, say so plainly in athlete language.",
          "Use nextStep for the one thing the athlete should do next. Do not tell the athlete to request, generate, refresh, or update a plan; lockin handles plan updates automatically.",
          "coachEvaluation is computed by code and is the source of truth. Do not change its status, adherence percentage, readiness gate, progress state, plan decision, or next action.",
          "Do not calculate adherence, readiness, progress, or plan status from raw logs. Use coachEvaluation and athleteSignals only.",
          "The headline and summary must reflect coachEvaluation.statusLabel. nextStep must match coachEvaluation.nextAction in athlete-facing words.",
          "shouldUpdatePlan must match coachEvaluation.planDecision.shouldUpdatePlan.",
          "Cite only numbers present in athleteSignals or coachContext, exactly as provided — never compute, estimate, or invent figures. Work at least one of the athlete's actual numbers into the summary.",
          "Pick exactly ONE actionable next step — the single highest-leverage lever right now. More than one ask dilutes all of them.",
          "Treat week-over-week volume comparisons as hedged observations, not injury predictions; the evidence behind load ratios is weak. When the wellness gate favors easy work and coachContext.plannedWork.todaySessions is not empty, gate today's intensity rather than rewriting the week. When todaySessions is empty, say there is no training today and make nextStep about rest, syncing data, or the next planned session.",
          "If there are no completed training logs or runs, say that you only know the starting profile and goals.",
          "If coachEvaluation says the week should update because of pain, very poor feel, overreaching, or progress concerns, explain the training reason without telling the athlete to request, generate, refresh, or update a plan.",
          "Never mention schemas, databases, proxy calls, JSON, validation, skill bundles, internal systems, or variable names.",
          "Never write snake_case, camelCase, raw field names, or code-like labels such as averageDeltaLast5, abovePlanBy2Count, maxPain, recent_pain_level_4_or_higher, or recent_effort_above_plan.",
          "watchItems must contain short human phrases only, for example 'Pain reached 4/10 recently' or 'Effort has been higher than planned'. Do not put raw flags in watchItems.",
          "Keep latestChange and recommendation as backward-compatible plain athlete text. latestChange should summarize the main recent signal; recommendation should match nextStep."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          coachContext: context,
          athleteSignals: trainingSignals,
          coachEvaluation,
          coachSnapshot: coachEvaluation.snapshot,
          coachReferencePoints: isHybrid ? coachReferencePoints : undefined,
          verdictRules: {
            keepSummaryUnderWords: 65,
            keepRunningReadUnderWords: 38,
            keepStrengthReadUnderWords: 38,
            keepNextStepUnderWords: 32,
            keepLatestChangeUnderWords: 38,
            keepRecommendationUnderWords: 32,
            noPlanMutation: true,
            oneActionableChange: true,
            todayHasPlannedSessions: context.plannedWork.todaySessions.length > 0,
            todaySessions: context.plannedWork.todaySessions,
            noTodayTrainingRule:
              context.plannedWork.todaySessions.length === 0
                ? "There are no planned sessions today. Do not tell the athlete to adjust, complete, or gate today's training."
                : undefined,
            citeOnlyProvidedNumbers: true,
            athleteLanguageOnly: true,
            noInternalMetricNames: true,
            separateRunningAndStrength: true,
            shouldUpdatePlanWhenNoSessionsArePlanned: true,
            coachTemperament: disciplineCoachTemperament,
            flatGoalMetricsRequiringProgression: flatGoalMetricsRequiringProgression(context).map((metric) => metric.label)
          }
        })
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "coach_verdict",
        strict: true,
        schema: coachVerdictSchema
      }
    }
  }, telemetry);

  if (!response.ok) {
    return { ok: false, status: response.status, body: response.body };
  }

  const outputText = extractOutputText(response.json);
  return { ok: true, verdict: JSON.parse(outputText) as CoachVerdict };
}

function buildCoachPromptPayload(
  context: CoachContext,
  repair?: RepairInput,
  plannedRuns?: PlannedRunSummary[],
  guidance?: StrengthPlannerGuidance
): Record<string, unknown> {
  const hasSelectedTrainingDays = context.profile.trainingDays.length > 0;
  const maxFutureStrengthSessions = hasSelectedTrainingDays
    ? Math.min(context.profile.weeklySessions, context.profile.trainingDayOffsets.length)
    : context.profile.weeklySessions;
  const outputRules: Record<string, unknown> = {
    todayIsLocked: true,
    selectedTrainingDays: context.profile.trainingDays,
    allowedDayOffsets: context.profile.trainingDayOffsets,
    maxFutureStrengthSessions,
    plannedEffort:
      "Every session and exercise must include plannedEffort. These labels are shown in the app before training, so light must mean intentionally light, hard must mean real goal stimulus, and max_output must only be used for a deliberate test.",
    coachTemperament: disciplineCoachTemperament,
    progression:
      "strengthGuardrails.progression is computed from coachContext.plannedWork.recentGoalPerformance and the previous working prescription, and it is enforced: for each goal metric keep the week's top working target inside allowedTopTarget and its sets at or below maxSetsOnTopTarget, or use setRoute (same target, one more set) when it is offered. Earned steps: pull-ups +1 rep; push-ups +1 below 15 reps, +1-2 below 30, +1-3 from 30; plank +5-10 s below 60 s, +5-15 s from 60 s. Never increase sets and the target together. Working values never exceed strengthGuardrails.workingCaps (tests excepted). Safety text alone cannot bypass earned progression.",
    strengthGuardrails: guidance?.guardrails ?? null,
    ...(guidance?.continuity ? { continuity: guidance.continuity } : {}),
    phase:
      "Prefix summary with exactly one adaptive phase: Build:, Offload:, Restore:, Maintenance:, or Assessment:. Explain separately why pull-ups, push-ups, and plank progressed, held, or reduced. Do not force a four-week calendar wave.",
    scheduling: hasSelectedTrainingDays
      ? "Use allowedDayOffsets as availability, not a quota. Schedule no more than maxFutureStrengthSessions strength sessions, and schedule fewer when recovery, running load, safety, or a week already in progress makes that better. Leave at least one of offsets 1 through 6 unused by both running and strength. If allowedDayOffsets is empty, return zero strength sessions and explain the current week is already underway. Never schedule dayOffset 0 because today is locked."
      : "Schedule no more than maxFutureStrengthSessions strength sessions across dayOffset 1 through 6. Schedule fewer when recovery or safety requires it, and leave at least one complete rest day. Never schedule dayOffset 0 because today is locked."
  };

  if (plannedRuns) {
    outputRules.thisWeeksPlannedRuns = plannedRuns;
    outputRules.runCoordination =
      "thisWeeksPlannedRuns are fixed and running has priority. Never schedule hard, very_hard, or max_output strength on a long, tempo, interval, hill, or race-run day, and never very_hard or max_output strength (tests included) on the day before a long run or the race. The union of run and strength offsets must leave one of offsets 1 through 6 completely unused.";
  }

  const basePayload = {
    coachContext: context,
    trainingSignals: guidance?.trainingSignals ?? null,
    outputRules
  };

  if (!repair) {
    return basePayload;
  }

  return {
    ...basePayload,
    repairRequest: {
      instruction:
        "The previous plan failed technical validation. Repair it once by changing only what is needed, then return schema-valid JSON only.",
      validationMessages: repair.messages,
      previousPlan: repair.previousPlan
    }
  };
}

/** The request body, capped at MAX_REQUEST_BODY_BYTES (413 above it). */
function readBody(req: IncomingMessage): Promise<string> {
  return readRequestBody(req);
}

/** The coach-chat model call: one Responses request through the telemetry wrapper. */
function coachChatModelCaller(apiKey: string, telemetry: OpenAIRequestTelemetry): CoachChatModelCall {
  return (body, { timeoutMs }) => fetchOpenAIResponse(apiKey, body, telemetry, { timeoutMs });
}

function writeJSON(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function queryValue(rawURL: string, name: string): string {
  return new URL(rawURL, "http://localhost").searchParams.get(name)?.trim() ?? "";
}

function autoPlanSource(value: unknown): AutoPlanSource {
  switch (cleanString(value)) {
    case "manual": return "manual";
    case "post_training": return "post_training";
    case "app_active": return "app_active";
    case "nightly": return "nightly";
    default: throw new Error("source must be manual, post_training, app_active, or nightly");
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function coachTelemetry(
  payload: CoachRequest,
  model: string,
  route: string,
  phase: string,
  context: CoachContext,
  repairAttempt = false
): OpenAIRequestTelemetry {
  return {
    route,
    phase,
    model,
    userId: payload.userId,
    contextState: context.readiness.state,
    hasRunning: Boolean(context.running),
    hasGarmin: Boolean(context.garmin?.wellness.length),
    repairAttempt
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isClientInputError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  return [
    "source must be",
    "request object is required",
    "request.userId is required",
    "messages array is required",
    "at least one user chat message is required",
    "chat message role must be",
    "chat message text must be",
    "chat message text is required",
    "each chat message must be"
  ].some((message) => error.message.includes(message));
}

async function fetchAvailableModels(apiKey: string): Promise<string[]> {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: {
      authorization: `Bearer ${apiKey}`
    }
  });

  if (!response.ok) {
    throw new Error(`OpenAI models request failed with HTTP ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as { data?: unknown };
  const data = Array.isArray(json.data) ? json.data : [];
  return filterAllowedModels(withDefaultCoachModel(pickTextModelIDs(data)));
}

function extractOutputText(response: unknown): string {
  if (!response || typeof response !== "object") {
    throw new Error("OpenAI response was not an object.");
  }

  const direct = (response as { output_text?: unknown }).output_text;
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }

  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    throw new Error("OpenAI response did not include output text.");
  }

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) {
        return text;
      }

      const json = (part as { json?: unknown }).json;
      if (json && typeof json === "object") {
        return JSON.stringify(json);
      }
    }
  }

  throw new Error("OpenAI response did not include output text.");
}
