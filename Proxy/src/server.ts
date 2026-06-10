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
import { validateWeeklyPlan } from "./coach/planner/validate-week-plan";
import { validateRunningWeek } from "./coach/planner/validate-running-week";
import { validateCombinedWeek } from "./coach/planner/validate-combined-week";
import type { CoachContext, CoachRequest, CoachVerdict, RunningWeek, WeeklyPlan } from "./coach/planner/types";
import { deleteWorkouts, garminSnapshot, garminStatus, pushWorkouts } from "./garmin/garmin-client";
import { defaultCoachModel, normalizeRequestedModel, pickTextModelIDs, withDefaultCoachModel } from "./model-selection";

const port = Number(process.env.PORT ?? 8787);
const apiKey = process.env.OPENAI_API_KEY;
const skillRoot = join(process.cwd(), "src", "coach", "skills", "fitness-coach-planner");
const runningSkillRoot = join(process.cwd(), "src", "coach", "skills", "running-coach-planner");

createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
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

      const context = await enrichWithGarmin(buildCoachContext(payload));
      const generated = await generateCoachVerdict(apiKey, model, context);

      if (!generated.ok) {
        res.writeHead(generated.status, { "content-type": "application/json" }).end(generated.body);
        return;
      }

      writeJSON(res, 200, normalizeCoachVerdict(generated.verdict, context));
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
      const context = await enrichWithGarmin(buildCoachContext(payload));

      const generatedRunning = await generateRunningWeek(apiKey, model, runningSkill, context);
      if (!generatedRunning.ok) {
        res.writeHead(generatedRunning.status, { "content-type": "application/json" }).end(generatedRunning.body);
        return;
      }

      let runningWeek = generatedRunning.week;
      const runningValidation = validateRunningWeek(runningWeek, context);
      if (!runningValidation.accepted) {
        const repairedRunning = await generateRunningWeek(apiKey, model, runningSkill, context, {
          messages: runningValidation.messages,
          previousPlan: runningWeek
        });

        if (!repairedRunning.ok) {
          res.writeHead(repairedRunning.status, { "content-type": "application/json" }).end(repairedRunning.body);
          return;
        }

        const repairedRunningValidation = validateRunningWeek(repairedRunning.week, context);
        if (!repairedRunningValidation.accepted) {
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

      const generatedStrength = await generateWeeklyPlan(apiKey, model, skill, context, undefined, plannedRuns);
      if (!generatedStrength.ok) {
        res.writeHead(generatedStrength.status, { "content-type": "application/json" }).end(generatedStrength.body);
        return;
      }

      let strengthPlan = generatedStrength.plan;
      const strengthMessages = [
        ...validateWeeklyPlan(strengthPlan, context).messages,
        ...validateCombinedWeek(runningWeek, strengthPlan)
      ];

      if (strengthMessages.length > 0) {
        const repairedStrength = await generateWeeklyPlan(
          apiKey,
          model,
          skill,
          context,
          { messages: strengthMessages, previousPlan: strengthPlan },
          plannedRuns
        );

        if (!repairedStrength.ok) {
          res.writeHead(repairedStrength.status, { "content-type": "application/json" }).end(repairedStrength.body);
          return;
        }

        const repairedStrengthMessages = [
          ...validateWeeklyPlan(repairedStrength.plan, context).messages,
          ...validateCombinedWeek(runningWeek, repairedStrength.plan)
        ];

        if (repairedStrengthMessages.length > 0) {
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
      writeJSON(res, 200, await garminStatus());
      return;
    }

    if (req.method === "GET" && req.url?.split("?")[0] === "/garmin/snapshot") {
      writeJSON(res, 200, await garminSnapshot(parseSinceDays(req.url)));
      return;
    }

    if (req.method === "POST" && req.url === "/garmin/push-workouts") {
      const payload = JSON.parse(await readBody(req)) as { workouts?: unknown };
      if (!Array.isArray(payload?.workouts)) {
        writeJSON(res, 400, { error: "workouts array is required" });
        return;
      }

      writeJSON(res, 200, await pushWorkouts(payload.workouts));
      return;
    }

    if (req.method === "POST" && req.url === "/garmin/delete-workouts") {
      const payload = JSON.parse(await readBody(req)) as { workoutIds?: unknown };
      if (!Array.isArray(payload?.workoutIds)) {
        writeJSON(res, 400, { error: "workoutIds array is required" });
        return;
      }

      writeJSON(res, 200, await deleteWorkouts(payload.workoutIds));
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

    const generated = await generateWeeklyPlan(apiKey, model, skill, context);

    if (!generated.ok) {
      res.writeHead(generated.status, { "content-type": "application/json" }).end(generated.body);
      return;
    }

    const validation = validateWeeklyPlan(generated.plan, context);

    if (!validation.accepted) {
      const repaired = await generateWeeklyPlan(apiKey, model, skill, context, {
        messages: validation.messages,
        previousPlan: generated.plan
      });

      if (!repaired.ok) {
        res.writeHead(repaired.status, { "content-type": "application/json" }).end(repaired.body);
        return;
      }

      const repairedValidation = validateWeeklyPlan(repaired.plan, context);
      if (repairedValidation.accepted) {
        res.writeHead(200, { "content-type": "application/json" }).end(repaired.outputText);
        return;
      }

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
    writeJSON(res, 500, { error: error instanceof Error ? error.message : "Unknown proxy error" });
  }
}).listen(port, () => {
  console.log(`Fitness coach proxy listening on port ${port}`);
});

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

const coachVerdictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "latestChange", "recommendation", "shouldUpdatePlan", "contextState", "safetyFlags"],
  properties: {
    headline: { type: "string" },
    summary: { type: "string" },
    latestChange: { type: "string" },
    recommendation: { type: "string" },
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
async function enrichWithGarmin(context: CoachContext): Promise<CoachContext> {
  try {
    // Enrichment only consumes status + wellness, and it sits on the coach
    // request path, so skip activities and keep the timeout budget tight.
    const snapshot = await garminSnapshot(7, fetch, { includeActivities: false, timeoutMs: 10_000 });
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
  repair?: RepairInput,
  plannedRuns?: PlannedRunSummary[]
): Promise<GenerateResult> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
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
    })
  });

  if (!response.ok) {
    return { ok: false, status: response.status, body: await response.text() };
  }

  const json = await response.json();
  const outputText = extractOutputText(json);
  return { ok: true, outputText, plan: JSON.parse(outputText) as WeeklyPlan };
}

async function generateRunningWeek(
  apiKey: string,
  model: string,
  skill: RunningSkillBundle,
  context: CoachContext,
  repair?: RunningRepairInput
): Promise<RunningGenerateResult> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
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
    })
  });

  if (!response.ok) {
    return { ok: false, status: response.status, body: await response.text() };
  }

  const json = await response.json();
  const outputText = extractOutputText(json);
  return { ok: true, outputText, week: JSON.parse(outputText) as RunningWeek };
}

function buildRunningPromptPayload(context: CoachContext, repair?: RunningRepairInput): Record<string, unknown> {
  const basePayload = {
    coachContext: context,
    outputRules: {
      todayIsLocked: true,
      selectedRunningDays: context.running?.runningDays ?? [],
      allowedDayOffsets: context.running?.runningDayOffsets ?? [],
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

async function generateCoachVerdict(apiKey: string, model: string, context: CoachContext): Promise<VerdictResult> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            "You are a human, athlete-facing training coach inside lockin.",
            disciplineCoachSystemPrompt,
            "Write like an experienced strength coach: direct, calm, practical, and not technical.",
            "Return a short read on the athlete's current state. Do not create or rewrite the week plan.",
            "If there are no completed training logs, say that you only know the starting profile and goals.",
            "If the latest session raises pain, poor how-you-felt feedback, overreaching, or progress concerns, recommend updating the week.",
            "Never mention schemas, databases, proxy calls, JSON, validation, skill bundles, or internal systems."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            coachContext: context,
            verdictRules: {
              keepSummaryUnderWords: 65,
              keepLatestChangeUnderWords: 45,
              keepRecommendationUnderWords: 45,
              noPlanMutation: true,
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
    })
  });

  if (!response.ok) {
    return { ok: false, status: response.status, body: await response.text() };
  }

  const json = await response.json();
  const outputText = extractOutputText(json);
  return { ok: true, verdict: JSON.parse(outputText) as CoachVerdict };
}

function buildCoachPromptPayload(
  context: CoachContext,
  repair?: RepairInput,
  plannedRuns?: PlannedRunSummary[]
): Record<string, unknown> {
  const hasSelectedOffsets = context.profile.trainingDayOffsets.length > 0;
  const outputRules: Record<string, unknown> = {
    todayIsLocked: true,
    selectedTrainingDays: context.profile.trainingDays,
    allowedDayOffsets: context.profile.trainingDayOffsets,
    selectedFutureTrainingDayCount: hasSelectedOffsets ? context.profile.trainingDayOffsets.length : null,
    plannedEffort:
      "Every session and exercise must include plannedEffort. These labels are shown in the app before training, so light must mean intentionally light, hard must mean real goal stimulus, and max_output must only be used for a deliberate test.",
    coachTemperament: disciplineCoachTemperament,
    progression:
      "Use coachContext.plannedWork.recentGoalTargets. If clean recent training has repeated the same pull-up, push-up, or plank target, the next normal plan must visibly progress that metric by increasing reps, hold time, sets, or another single stress variable unless safetyFlags explain why not.",
    scheduling: hasSelectedOffsets
      ? "Schedule exactly one strength session on each selected future training day. Use only allowedDayOffsets and treat all other offsets as rest days. Never schedule dayOffset 0 because today is locked."
      : "Schedule exactly the requested number of strength sessions across dayOffset 1 through 6. Never schedule dayOffset 0 because today is locked."
  };

  if (plannedRuns) {
    outputRules.thisWeeksPlannedRuns = plannedRuns;
    outputRules.runCoordination =
      "thisWeeksPlannedRuns are fixed. Manage total weekly fatigue. Never schedule very_hard or max_output strength on a hard run day (long, tempo, intervals, hills).";
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

function normalizeCoachVerdict(verdict: CoachVerdict, context: CoachContext): CoachVerdict {
  const noPlannedSessions = context.adherence.planned === 0;
  const shouldUpdateForReadiness = context.readiness.state === "recovery_needed" || context.readiness.state === "overreaching";
  const shouldUpdateForFlatProgression = flatGoalMetricsRequiringProgression(context).length > 0;

  return {
    ...verdict,
    contextState: context.readiness.state,
    shouldUpdatePlan: verdict.shouldUpdatePlan || noPlannedSessions || shouldUpdateForReadiness || shouldUpdateForFlatProgression
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
