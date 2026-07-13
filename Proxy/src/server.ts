import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCoachContext } from "./coach/planner/build-coach-context";
import {
  disciplineCoachSystemPrompt,
  disciplineCoachTemperament,
  flatGoalMetricsRequiringProgression
} from "./coach/planner/coach-temperament";
import { coachReferencePoints, computeTrainingSignals } from "./coach/planner/compute-training-signals";
import { validateWeeklyPlan } from "./coach/planner/validate-week-plan";
import { validateRunningWeek } from "./coach/planner/validate-running-week";
import {
  fixedRunningLoadSupportsStrengthMaintenance,
  validateCombinedWeek
} from "./coach/planner/validate-combined-week";
import { evaluateCoachRead } from "./coach/planner/evaluate-coach-read";
import { normalizeCoachVerdict } from "./coach/planner/normalize-coach-verdict";
import type { CoachContext, CoachEvaluation, CoachRequest, CoachSnapshot, CoachVerdict, RunningWeek, WeeklyPlan } from "./coach/planner/types";
import type { TrainingSignals } from "./coach/planner/compute-training-signals";
import {
  AutoPlanStore,
  markAutoPlanFailed,
  markAutoPlanGenerated,
  prepareAutoPlanTrigger,
  refreshRequestForNightly,
  toAutoPlanStatus,
  type AutoPlanGeneratedPlan,
  type AutoPlanSource,
  type AutoPlanTrigger
} from "./coach/auto-plan";
import { buildCoachChatResponse, normalizeCoachChatMessages, type CoachChatMessage } from "./coach/chat";
import { connectGarmin, deleteWorkouts, disconnectGarmin, garminSnapshot, garminStatus, pushWorkouts } from "./garmin/garmin-client";
import { GarminSyncInputError, getGarminSyncStatus, retryGarminSync, submitGarminSyncPlan } from "./garmin/garmin-sync";
import { GarminSyncStore } from "./garmin/garmin-sync-store";
import { defaultCoachModel, normalizeRequestedModel, pickTextModelIDs, withDefaultCoachModel } from "./model-selection";
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

createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
  });
  try {
    if (await handleLockinApi(req, res)) {
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
      writeJSON(res, 200, await runAutoPlanTrigger(parseAutoPlanTrigger(JSON.parse(await readBody(req)))));
      return;
    }

    if (req.method === "POST" && req.url === "/coach-verdict") {
      if (!apiKey) {
        writeJSON(res, 500, { error: "OPENAI_API_KEY is not set" });
        return;
      }

      const payload = JSON.parse(await readBody(req)) as CoachRequest;
      const model = normalizeRequestedModel(payload.model);
      if (!model) {
        writeJSON(res, 400, { error: "model is required" });
        return;
      }

      const context = await enrichWithGarmin(buildCoachContext(payload), payload.userId);
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
      const chatPayload = parseCoachChatPayload(JSON.parse(await readBody(req)));
      const payload = chatPayload.request;

      const context = await enrichWithGarmin(buildCoachContext(payload), payload.userId);
      const trainingSignals = computeTrainingSignals(context);
      const evaluation = evaluateCoachRead(context, trainingSignals);
      writeJSON(res, 200, buildCoachChatResponse({
        messages: chatPayload.messages,
        context,
        signals: trainingSignals,
        evaluation
      }));
      return;
    }

    if (req.method === "POST" && req.url === "/generate-week") {
      if (!apiKey) {
        writeJSON(res, 500, { error: "OPENAI_API_KEY is not set" });
        return;
      }

      const payload = JSON.parse(await readBody(req)) as CoachRequest;
      const model = normalizeRequestedModel(payload.model);
      if (!model) {
        writeJSON(res, 400, { error: "model is required" });
        return;
      }

      if (!payload.running) {
        writeJSON(res, 400, { error: "running goal is required for /generate-week" });
        return;
      }

      if (Number.isNaN(Date.parse(payload.running.raceGoal?.raceDate))) {
        writeJSON(res, 400, { error: "running raceGoal.raceDate must be an ISO-8601 date" });
        return;
      }

      const [skill, runningSkill] = await Promise.all([loadSkillBundle(), loadRunningSkillBundle()]);
      const context = await enrichWithGarmin(buildCoachContext(payload), payload.userId);

      const generatedRunning = await generateRunningWeek(
        apiKey,
        model,
        runningSkill,
        context,
        coachTelemetry(payload, model, "/generate-week", "running_initial", context)
      );
      if (!generatedRunning.ok) {
        res.writeHead(generatedRunning.status, { "content-type": "application/json" }).end(generatedRunning.body);
        return;
      }

      let runningWeek = generatedRunning.week;
      const runningValidation = validateRunningWeek(runningWeek, context);
      if (!runningValidation.accepted) {
        await recordCoachValidationFailure(
          coachTelemetry(payload, model, "/generate-week", "running_initial_validation", context),
          runningValidation.messages
        );
        const repairedRunning = await generateRunningWeek(
          apiKey,
          model,
          runningSkill,
          context,
          coachTelemetry(payload, model, "/generate-week", "running_repair", context, true),
          {
            messages: runningValidation.messages,
            previousPlan: runningWeek
          }
        );

        if (!repairedRunning.ok) {
          res.writeHead(repairedRunning.status, { "content-type": "application/json" }).end(repairedRunning.body);
          return;
        }

        const repairedRunningValidation = validateRunningWeek(repairedRunning.week, context);
        if (!repairedRunningValidation.accepted) {
          await recordCoachValidationFailure(
            coachTelemetry(payload, model, "/generate-week", "running_repair_validation", context, true),
            repairedRunningValidation.messages
          );
          writeJSON(res, 422, {
            error: "Generated running week failed validation after one repair attempt.",
            messages: repairedRunningValidation.messages,
            firstAttemptMessages: runningValidation.messages,
            contextState: context.readiness.state
          });
          return;
        }

        runningWeek = repairedRunning.week;
      }

      const plannedRuns = runningWeek.sessions.map(({ dayOffset, kind, distanceKm, elevationMeters }) => ({
        dayOffset,
        kind,
        distanceKm,
        elevationMeters
      }));

      const generatedStrength = await generateWeeklyPlan(
        apiKey,
        model,
        skill,
        context,
        coachTelemetry(payload, model, "/generate-week", "strength_initial", context),
        undefined,
        plannedRuns
      );
      if (!generatedStrength.ok) {
        res.writeHead(generatedStrength.status, { "content-type": "application/json" }).end(generatedStrength.body);
        return;
      }

      let strengthPlan = generatedStrength.plan;
      const strengthValidationOptions = {
        allowProgressionHoldForRunning: fixedRunningLoadSupportsStrengthMaintenance(runningWeek, context)
      };
      const strengthMessages = [
        ...validateWeeklyPlan(strengthPlan, context, strengthValidationOptions).messages,
        ...validateCombinedWeek(runningWeek, strengthPlan)
      ];

      if (strengthMessages.length > 0) {
        await recordCoachValidationFailure(
          coachTelemetry(payload, model, "/generate-week", "strength_initial_validation", context),
          strengthMessages
        );
        const repairedStrength = await generateWeeklyPlan(
          apiKey,
          model,
          skill,
          context,
          coachTelemetry(payload, model, "/generate-week", "strength_repair", context, true),
          { messages: strengthMessages, previousPlan: strengthPlan },
          plannedRuns
        );

        if (!repairedStrength.ok) {
          res.writeHead(repairedStrength.status, { "content-type": "application/json" }).end(repairedStrength.body);
          return;
        }

        const repairedStrengthMessages = [
          ...validateWeeklyPlan(repairedStrength.plan, context, strengthValidationOptions).messages,
          ...validateCombinedWeek(runningWeek, repairedStrength.plan)
        ];

        if (repairedStrengthMessages.length > 0) {
          await recordCoachValidationFailure(
            coachTelemetry(payload, model, "/generate-week", "strength_repair_validation", context, true),
            repairedStrengthMessages
          );
          writeJSON(res, 422, {
            error: "Generated plan failed technical validation after one repair attempt.",
            messages: repairedStrengthMessages,
            firstAttemptMessages: strengthMessages,
            contextState: context.readiness.state
          });
          return;
        }

        strengthPlan = repairedStrength.plan;
      }

      writeJSON(res, 200, {
        summary: `${runningWeek.summary} ${strengthPlan.summary}`,
        safetyFlags: [...new Set([...runningWeek.safetyFlags, ...strengthPlan.safetyFlags])],
        runningWeek,
        strengthWeek: strengthPlan
      });
      return;
    }

    if (req.method === "GET" && req.url?.split("?")[0] === "/garmin/status") {
      writeJSON(res, 200, await garminStatus(fetch, { userId: queryValue(req.url, "userId") }));
      return;
    }

    if (req.method === "GET" && req.url?.split("?")[0] === "/garmin/snapshot") {
      writeJSON(res, 200, await garminSnapshot(parseSinceDays(req.url), fetch, { userId: queryValue(req.url, "userId") }));
      return;
    }

    if (req.method === "POST" && req.url === "/garmin/connect") {
      const payload = JSON.parse(await readBody(req)) as { userId?: unknown; email?: unknown; password?: unknown; mfaCode?: unknown };
      writeJSON(res, 200, await connectGarmin({
        userId: typeof payload.userId === "string" ? payload.userId : "",
        email: typeof payload.email === "string" ? payload.email : "",
        password: typeof payload.password === "string" ? payload.password : "",
        mfaCode: typeof payload.mfaCode === "string" ? payload.mfaCode : undefined
      }));
      return;
    }

    if (req.method === "POST" && req.url === "/garmin/disconnect") {
      const payload = JSON.parse(await readBody(req)) as { userId?: unknown };
      writeJSON(res, 200, await disconnectGarmin(typeof payload.userId === "string" ? payload.userId : ""));
      return;
    }

    if (req.method === "GET" && req.url?.split("?")[0] === "/garmin/sync-status") {
      writeJSON(res, 200, await getGarminSyncStatus(garminSyncStore, queryValue(req.url, "userId")));
      return;
    }

    if (req.method === "POST" && req.url === "/garmin/sync-plan") {
      writeJSON(res, 200, await submitGarminSyncPlan(garminSyncStore, JSON.parse(await readBody(req))));
      return;
    }

    if (req.method === "POST" && req.url === "/garmin/retry-sync") {
      const payload = JSON.parse(await readBody(req)) as { userId?: unknown };
      writeJSON(res, 200, await retryGarminSync(garminSyncStore, typeof payload.userId === "string" ? payload.userId : ""));
      return;
    }

    if (req.method === "POST" && req.url === "/garmin/push-workouts") {
      const payload = JSON.parse(await readBody(req)) as { workouts?: unknown; userId?: unknown };
      if (!Array.isArray(payload?.workouts)) {
        writeJSON(res, 400, { error: "workouts array is required" });
        return;
      }

      writeJSON(res, 200, await pushWorkouts(payload.workouts, fetch, { userId: typeof payload.userId === "string" ? payload.userId : undefined }));
      return;
    }

    if (req.method === "POST" && req.url === "/garmin/delete-workouts") {
      const payload = JSON.parse(await readBody(req)) as { workoutIds?: unknown; userId?: unknown };
      if (!Array.isArray(payload?.workoutIds)) {
        writeJSON(res, 400, { error: "workoutIds array is required" });
        return;
      }

      writeJSON(res, 200, await deleteWorkouts(payload.workoutIds, fetch, { userId: typeof payload.userId === "string" ? payload.userId : undefined }));
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

    const payload = JSON.parse(await readBody(req)) as CoachRequest;
    const model = normalizeRequestedModel(payload.model);
    if (!model) {
      writeJSON(res, 400, { error: "model is required" });
      return;
    }

    const skill = await loadSkillBundle();
    const context = buildCoachContext(payload);

    const generated = await generateWeeklyPlan(
      apiKey,
      model,
      skill,
      context,
      coachTelemetry(payload, model, "/generate-week-plan", "strength_initial", context)
    );

    if (!generated.ok) {
      res.writeHead(generated.status, { "content-type": "application/json" }).end(generated.body);
      return;
    }

    const validation = validateWeeklyPlan(generated.plan, context);

    if (!validation.accepted) {
      await recordCoachValidationFailure(
        coachTelemetry(payload, model, "/generate-week-plan", "strength_initial_validation", context),
        validation.messages
      );
      const repaired = await generateWeeklyPlan(
        apiKey,
        model,
        skill,
        context,
        coachTelemetry(payload, model, "/generate-week-plan", "strength_repair", context, true),
        {
          messages: validation.messages,
          previousPlan: generated.plan
        }
      );

      if (!repaired.ok) {
        res.writeHead(repaired.status, { "content-type": "application/json" }).end(repaired.body);
        return;
      }

      const repairedValidation = validateWeeklyPlan(repaired.plan, context);
      if (repairedValidation.accepted) {
        res.writeHead(200, { "content-type": "application/json" }).end(repaired.outputText);
        return;
      }

      await recordCoachValidationFailure(
        coachTelemetry(payload, model, "/generate-week-plan", "strength_repair_validation", context, true),
        repairedValidation.messages
      );
      writeJSON(res, 422, {
        error: "Generated plan failed technical validation after one repair attempt.",
        messages: repairedValidation.messages,
        firstAttemptMessages: validation.messages,
        contextState: context.readiness.state
      });
      return;
    }

    res.writeHead(200, { "content-type": "application/json" }).end(generated.outputText);
  } catch (error) {
    if (error instanceof GarminSyncInputError) {
      writeJSON(res, 400, { error: error.message });
      return;
    }
    if (isClientInputError(error)) {
      writeJSON(res, 400, { error: error.message });
      return;
    }
    writeJSON(res, 500, { error: error instanceof Error ? error.message : "Unknown proxy error" });
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

type PlannedRunSummary = Pick<RunningWeek["sessions"][number], "dayOffset" | "kind" | "distanceKm" | "elevationMeters">;

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
    const generated = await generateAutoPlan(trigger.request);
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
  payload: CoachRequest
): Promise<Omit<AutoPlanGeneratedPlan, "planRevisionId" | "generatedAt" | "localDate" | "source">> {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const model = normalizeRequestedModel(payload.model);
  if (!model) {
    throw new Error("model is required");
  }

  const skill = await loadSkillBundle();
  const context = await enrichWithGarmin(buildCoachContext(payload), payload.userId);

  if (!payload.running) {
    const generated = await generateWeeklyPlan(
      apiKey,
      model,
      skill,
      context,
      coachTelemetry(payload, model, "/plan/trigger", "strength_initial", context)
    );
    if (!generated.ok) {
      throw new Error(generated.body);
    }

    let strengthWeek = generated.plan;
    const validation = validateWeeklyPlan(strengthWeek, context);
    if (!validation.accepted) {
      await recordCoachValidationFailure(
        coachTelemetry(payload, model, "/plan/trigger", "strength_initial_validation", context),
        validation.messages
      );
      const repaired = await generateWeeklyPlan(
        apiKey,
        model,
        skill,
        context,
        coachTelemetry(payload, model, "/plan/trigger", "strength_repair", context, true),
        {
          messages: validation.messages,
          previousPlan: strengthWeek
        }
      );
      if (!repaired.ok) {
        throw new Error(repaired.body);
      }
      const repairedValidation = validateWeeklyPlan(repaired.plan, context);
      if (!repairedValidation.accepted) {
        await recordCoachValidationFailure(
          coachTelemetry(payload, model, "/plan/trigger", "strength_repair_validation", context, true),
          repairedValidation.messages
        );
        throw new Error(`Generated plan failed technical validation after one repair attempt: ${repairedValidation.messages.join(" ")}`);
      }
      strengthWeek = repaired.plan;
    }

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
  const generatedRunning = await generateRunningWeek(
    apiKey,
    model,
    runningSkill,
    context,
    coachTelemetry(payload, model, "/plan/trigger", "running_initial", context)
  );
  if (!generatedRunning.ok) {
    throw new Error(generatedRunning.body);
  }

  let runningWeek = generatedRunning.week;
  const runningValidation = validateRunningWeek(runningWeek, context);
  if (!runningValidation.accepted) {
    await recordCoachValidationFailure(
      coachTelemetry(payload, model, "/plan/trigger", "running_initial_validation", context),
      runningValidation.messages
    );
    const repairedRunning = await generateRunningWeek(
      apiKey,
      model,
      runningSkill,
      context,
      coachTelemetry(payload, model, "/plan/trigger", "running_repair", context, true),
      {
        messages: runningValidation.messages,
        previousPlan: runningWeek
      }
    );
    if (!repairedRunning.ok) {
      throw new Error(repairedRunning.body);
    }
    const repairedRunningValidation = validateRunningWeek(repairedRunning.week, context);
    if (!repairedRunningValidation.accepted) {
      await recordCoachValidationFailure(
        coachTelemetry(payload, model, "/plan/trigger", "running_repair_validation", context, true),
        repairedRunningValidation.messages
      );
      throw new Error(`Generated running week failed validation after one repair attempt: ${repairedRunningValidation.messages.join(" ")}`);
    }
    runningWeek = repairedRunning.week;
  }

  const plannedRuns = runningWeek.sessions.map(({ dayOffset, kind, distanceKm, elevationMeters }) => ({
    dayOffset,
    kind,
    distanceKm,
    elevationMeters
  }));
  const generatedStrength = await generateWeeklyPlan(
    apiKey,
    model,
    skill,
    context,
    coachTelemetry(payload, model, "/plan/trigger", "strength_initial", context),
    undefined,
    plannedRuns
  );
  if (!generatedStrength.ok) {
    throw new Error(generatedStrength.body);
  }

  let strengthWeek = generatedStrength.plan;
  const strengthValidationOptions = {
    allowProgressionHoldForRunning: fixedRunningLoadSupportsStrengthMaintenance(runningWeek, context)
  };
  const strengthMessages = [
    ...validateWeeklyPlan(strengthWeek, context, strengthValidationOptions).messages,
    ...validateCombinedWeek(runningWeek, strengthWeek)
  ];
  if (strengthMessages.length > 0) {
    await recordCoachValidationFailure(
      coachTelemetry(payload, model, "/plan/trigger", "strength_initial_validation", context),
      strengthMessages
    );
    const repairedStrength = await generateWeeklyPlan(
      apiKey,
      model,
      skill,
      context,
      coachTelemetry(payload, model, "/plan/trigger", "strength_repair", context, true),
      { messages: strengthMessages, previousPlan: strengthWeek },
      plannedRuns
    );
    if (!repairedStrength.ok) {
      throw new Error(repairedStrength.body);
    }
    const repairedStrengthMessages = [
      ...validateWeeklyPlan(repairedStrength.plan, context, strengthValidationOptions).messages,
      ...validateCombinedWeek(runningWeek, repairedStrength.plan)
    ];
    if (repairedStrengthMessages.length > 0) {
      await recordCoachValidationFailure(
        coachTelemetry(payload, model, "/plan/trigger", "strength_repair_validation", context, true),
        repairedStrengthMessages
      );
      throw new Error(`Generated plan failed technical validation after one repair attempt: ${repairedStrengthMessages.join(" ")}`);
    }
    strengthWeek = repairedStrength.plan;
  }

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

function parseAutoPlanTrigger(payload: Record<string, unknown>): AutoPlanTrigger {
  const source = autoPlanSource(payload.source);
  const request = payload.request;
  if (!isRecord(request)) {
    throw new Error("request object is required");
  }
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
    void runDueNightlyAutoPlans();
  }, intervalMs);
  timer.unref();
}

async function runDueNightlyAutoPlans(): Promise<void> {
  const now = autoPlanStore.now();
  const dueUsers = await autoPlanStore.usersDueForNightly(now);
  for (const user of dueUsers) {
    if (!user.latestRequest || user.status === "generating") {
      continue;
    }
    try {
      await runAutoPlanTrigger({
        source: "nightly",
        request: refreshRequestForNightly(user.latestRequest, now, user.timeZone),
        reason: "Nightly planning window.",
        timeZone: user.timeZone
      });
    } catch (error) {
      console.error(`Auto plan failed for ${user.userId}:`, error);
    }
  }
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

// Attach Garmin wellness to the coach context. Any sidecar failure means the
// coach simply plans without Garmin data — never block plan generation.
async function enrichWithGarmin(context: CoachContext, userId?: string): Promise<CoachContext> {
  try {
    // Enrichment only consumes status + wellness, and it sits on the coach
    // request path, so skip activities and keep the timeout budget tight.
    const snapshot = await garminSnapshot(7, fetch, { includeActivities: false, timeoutMs: 10_000, userId });
    if (!snapshot.status.loggedIn || snapshot.wellness.length === 0) {
      return context;
    }

    // The sidecar promises most-recent-first, but pick by max date anyway.
    const latest = [...snapshot.wellness].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];

    context.garmin = { wellness: snapshot.wellness };
    if (latest && latest.trainingReadiness > 0 && latest.trainingReadiness < 30) {
      context.readiness.riskFlags.push("garmin: training readiness low");
    }
  } catch {
    // Degraded mode: leave the context untouched.
  }
  return context;
}

async function generateWeeklyPlan(
  apiKey: string,
  model: string,
  skill: SkillBundle,
  context: CoachContext,
  telemetry: OpenAIRequestTelemetry,
  repair?: RepairInput,
  plannedRuns?: PlannedRunSummary[]
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
        content: JSON.stringify(buildCoachPromptPayload(context, repair, plannedRuns))
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "weekly_training_plan",
        strict: true,
        schema: skill.weeklyPlanSchema
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
  repair?: RunningRepairInput
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
        content: JSON.stringify(buildRunningPromptPayload(context, repair))
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

function buildRunningPromptPayload(context: CoachContext, repair?: RunningRepairInput): Record<string, unknown> {
  const basePayload = {
    coachContext: context,
    outputRules: {
      todayIsLocked: true,
      availableRunningDays: context.running?.runningDays ?? [],
      availableDayOffsets: context.running?.runningDayOffsets ?? [],
      longRunDay: context.running?.longRunDay ?? null,
      longRunDayOffset: context.running?.longRunDayOffset ?? null
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
  plannedRuns?: PlannedRunSummary[]
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
      "Use coachContext.plannedWork.recentGoalPerformance as the progression source of truth. Clean target+2 performance earns immediate +1 rep for pull-ups or push-ups and +5-10 seconds for plank; otherwise the second consecutive clean completion at or above the same standard earns progression. Never increase sets and reps or hold time together. Safety text alone cannot bypass earned progression.",
    phase:
      "Prefix summary with exactly one adaptive phase: Build:, Offload:, Restore:, Maintenance:, or Assessment:. Explain separately why pull-ups, push-ups, and plank progressed, held, or reduced. Do not force a four-week calendar wave.",
    scheduling: hasSelectedTrainingDays
      ? "Use allowedDayOffsets as availability, not a quota. Schedule no more than maxFutureStrengthSessions strength sessions, and schedule fewer when recovery, running load, safety, or a week already in progress makes that better. Leave at least one of offsets 1 through 6 unused by both running and strength. If allowedDayOffsets is empty, return zero strength sessions and explain the current week is already underway. Never schedule dayOffset 0 because today is locked."
      : "Schedule no more than maxFutureStrengthSessions strength sessions across dayOffset 1 through 6. Schedule fewer when recovery or safety requires it, and leave at least one complete rest day. Never schedule dayOffset 0 because today is locked."
  };

  if (plannedRuns) {
    outputRules.thisWeeksPlannedRuns = plannedRuns;
    outputRules.runCoordination =
      "thisWeeksPlannedRuns are fixed and running has priority. Never schedule hard, very_hard, or max_output strength on a long, tempo, interval, hill, or race-run day. The union of run and strength offsets must leave one of offsets 1 through 6 completely unused.";
  }

  const basePayload = {
    coachContext: context,
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function writeJSON(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function parseSinceDays(rawURL: string): number {
  const raw = new URL(rawURL, "http://localhost").searchParams.get("sinceDays");
  const parsed = Number(raw);
  return raw !== null && raw.trim() !== "" && Number.isFinite(parsed) ? parsed : 7;
}

function queryValue(rawURL: string, name: string): string {
  return new URL(rawURL, "http://localhost").searchParams.get(name)?.trim() ?? "";
}

function parseCoachChatPayload(value: unknown): { request: CoachRequest; messages: CoachChatMessage[] } {
  if (!isRecord(value) || !isRecord(value.request)) {
    throw new Error("request object is required");
  }
  if (!Array.isArray(value.messages)) {
    throw new Error("messages array is required");
  }

  const messages: CoachChatMessage[] = value.messages.map((message): CoachChatMessage => {
    if (!isRecord(message)) {
      throw new Error("each chat message must be an object");
    }
    const role = cleanString(message.role);
    if (role !== "user" && role !== "coach") {
      throw new Error("chat message role must be user or coach");
    }
    const text = cleanString(message.text);
    if (!text) {
      throw new Error("chat message text is required");
    }
    return {
      role,
      text,
      createdAt: cleanString(message.createdAt) || undefined
    };
  });

  return {
    request: value.request as CoachRequest,
    messages: normalizeCoachChatMessages(messages)
  };
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
  return withDefaultCoachModel(pickTextModelIDs(data));
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
