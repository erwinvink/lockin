import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCoachContext } from "./coach/skills/fitness-coach-planner/scripts/build-coach-context";
import { validateWeeklyPlan } from "./coach/skills/fitness-coach-planner/scripts/validate-week-plan";
import type { CoachContext, CoachRequest, CoachVerdict, RunningCoachRequest, RunningWeekPlan, WeeklyPlan } from "./coach/skills/fitness-coach-planner/scripts/types";
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

      const context = buildCoachContext(payload);
      const generated = await generateCoachVerdict(apiKey, model, context);

      if (!generated.ok) {
        res.writeHead(generated.status, { "content-type": "application/json" }).end(generated.body);
        return;
      }

      writeJSON(res, 200, normalizeCoachVerdict(generated.verdict, context));
      return;
    }

    if (req.method === "POST" && req.url === "/generate-running-week") {
      if (!apiKey) {
        writeJSON(res, 500, { error: "OPENAI_API_KEY is not set" });
        return;
      }

      const payload = JSON.parse(await readBody(req)) as RunningCoachRequest;
      const model = normalizeRequestedModel(payload.model);
      if (!model) {
        writeJSON(res, 400, { error: "model is required" });
        return;
      }

      const skill = await loadRunningSkillBundle();
      const generated = await generateRunningWeek(apiKey, model, skill, payload);

      if (!generated.ok) {
        res.writeHead(generated.status, { "content-type": "application/json" }).end(generated.body);
        return;
      }

      const validation = validateRunningWeekPlan(generated.plan, payload);
      if (!validation.accepted) {
        writeJSON(res, 422, {
          error: "Generated running week failed technical validation.",
          messages: validation.messages
        });
        return;
      }

      res.writeHead(200, { "content-type": "application/json" }).end(generated.outputText);
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
  runningWeekSchema: Record<string, unknown>;
};

type RepairInput = {
  messages: string[];
  previousPlan: WeeklyPlan;
};

type GenerateResult =
  | { ok: true; outputText: string; plan: WeeklyPlan }
  | { ok: false; status: number; body: string };

type VerdictResult =
  | { ok: true; verdict: CoachVerdict }
  | { ok: false; status: number; body: string };

type RunningGenerateResult =
  | { ok: true; outputText: string; plan: RunningWeekPlan }
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
  const [instructions, runningWeekSchemaRaw] = await Promise.all([
    readFile(join(runningSkillRoot, "SKILL.md"), "utf8"),
    readFile(join(runningSkillRoot, "references", "running-week.schema.json"), "utf8")
  ]);

  return {
    instructions,
    runningWeekSchema: JSON.parse(runningWeekSchemaRaw) as Record<string, unknown>
  };
}

async function generateWeeklyPlan(
  apiKey: string,
  model: string,
  skill: SkillBundle,
  context: CoachContext,
  repair?: RepairInput
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
          content: JSON.stringify(buildCoachPromptPayload(context, repair))
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
            "Write like an experienced coach: direct, calm, practical, and not technical.",
            "Return a short read on the athlete's current state. Do not create or rewrite the week plan.",
            "If there are no completed training logs, say that you only know the starting profile and goals.",
            "If the latest session raises pain, fatigue, overreaching, or progress concerns, recommend updating the week.",
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
              shouldUpdatePlanWhenNoSessionsArePlanned: true
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

async function generateRunningWeek(
  apiKey: string,
  model: string,
  skill: RunningSkillBundle,
  request: RunningCoachRequest
): Promise<RunningGenerateResult> {
  const allowedDayOffsets = normalizeFutureDayOffsets(request.profile.trainingDayOffsets);
  const hasSelectedOffsets = allowedDayOffsets.length > 0;
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
            skill.instructions
          ].join("\n\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            runningProfile: request.profile,
            weekStart: request.weekStart,
            recentRunningLogs: request.runningLogs,
            plannedRuns: request.plannedRuns,
            outputRules: {
              selectedRunningDays: request.profile.trainingDays ?? [],
              allowedDayOffsets: hasSelectedOffsets ? allowedDayOffsets : [1, 2, 3, 4, 5, 6],
              selectedRunningDayCount: hasSelectedOffsets ? allowedDayOffsets.length : null,
              sessions: hasSelectedOffsets
                ? "Return exactly one running session on each selected future running day. Use only allowedDayOffsets. Never use dayOffset 0 because today is locked."
                : "Return 3 to 5 sessions across dayOffset 1 through 6. Never use dayOffset 0 because today is locked.",
              manualFirst: true,
              noHealthKitOrGpsAssumptions: true
            }
          })
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
  return { ok: true, outputText, plan: JSON.parse(outputText) as RunningWeekPlan };
}

function buildCoachPromptPayload(context: CoachContext, repair?: RepairInput): Record<string, unknown> {
  const hasSelectedOffsets = context.profile.trainingDayOffsets.length > 0;
  const basePayload = {
    coachContext: context,
    schedulingRules: {
      selectedTrainingDays: context.profile.trainingDays,
      allowedDayOffsets: hasSelectedOffsets ? context.profile.trainingDayOffsets : [1, 2, 3, 4, 5, 6],
      selectedTrainingDayCount: context.profile.weeklySessions,
      forbiddenDayOffsets: [0],
      todayIsLocked: true,
      instruction:
        hasSelectedOffsets
          ? "Schedule exactly one strength session on each selected future training day. Use only allowedDayOffsets and treat all other offsets as rest days. Never schedule dayOffset 0 because today is locked."
          : "Schedule exactly the requested number of strength sessions across dayOffset 1 through 6. Never schedule dayOffset 0 because today is locked."
    }
  };

  if (!repair) {
    return basePayload;
  }

  return {
    ...basePayload,
    repairRequest: {
      instruction:
        "The previous plan failed technical validation. Repair it once by changing only what is needed, preserve the schedulingRules, and return schema-valid JSON only.",
      validationMessages: repair.messages,
      previousPlan: repair.previousPlan
    }
  };
}

function normalizeCoachVerdict(verdict: CoachVerdict, context: CoachContext): CoachVerdict {
  const noPlannedSessions = context.adherence.planned === 0;
  const shouldUpdateForReadiness = context.readiness.state === "recovery_needed" || context.readiness.state === "overreaching";

  return {
    ...verdict,
    contextState: context.readiness.state,
    shouldUpdatePlan: verdict.shouldUpdatePlan || noPlannedSessions || shouldUpdateForReadiness
  };
}

function validateRunningWeekPlan(plan: RunningWeekPlan, request: RunningCoachRequest): { accepted: boolean; messages: string[] } {
  const messages: string[] = [];
  const kinds = new Set(["easy", "long", "recovery", "hills", "tempo", "intervals"]);
  const allowedDayOffsets = normalizeFutureDayOffsets(request.profile.trainingDayOffsets);
  const allowedDayOffsetSet = new Set(allowedDayOffsets);
  if (!plan || typeof plan !== "object") {
    return { accepted: false, messages: ["Running plan is not an object."] };
  }
  if (typeof plan.summary !== "string") messages.push("Running plan summary is missing.");
  if (!Array.isArray(plan.safetyFlags) || !plan.safetyFlags.every((flag) => typeof flag === "string")) {
    messages.push("Running plan safetyFlags must be a string array.");
  }
  if (!Array.isArray(plan.sessions) || plan.sessions.length === 0) {
    messages.push("Running plan must include sessions.");
    return { accepted: false, messages };
  }
  if (allowedDayOffsets.length > 0 && plan.sessions.length !== allowedDayOffsets.length) {
    messages.push(`Running plan must include exactly ${allowedDayOffsets.length} selected future running sessions.`);
  }

  let previousDayOffset = -1;
  for (const [index, session] of plan.sessions.entries()) {
    if (typeof session.dayOffset !== "number" || !Number.isInteger(session.dayOffset) || session.dayOffset < 1 || session.dayOffset > 6) {
      messages.push(`Running session ${index + 1} dayOffset must be 1 through 6; dayOffset 0 is today and cannot be planned during a refresh.`);
    }
    if (allowedDayOffsetSet.size > 0 && Number.isInteger(session.dayOffset) && !allowedDayOffsetSet.has(session.dayOffset)) {
      messages.push(`Running session ${index + 1} dayOffset ${session.dayOffset} is not one of the selected future running days.`);
    }
    if (session.dayOffset <= previousDayOffset) {
      messages.push(`Running session ${index + 1} dayOffset must be strictly later than the previous session.`);
    }
    previousDayOffset = session.dayOffset;
    if (!kinds.has(session.kind)) messages.push(`Running session ${index + 1} kind is unknown.`);
    if (session.distanceKm < 0 || session.durationMinutes < 0 || session.elevationMeters < 0) {
      messages.push(`Running session ${index + 1} has negative training values.`);
    }
  }

  return { accepted: messages.length === 0, messages };
}

function normalizeFutureDayOffsets(offsets: unknown): number[] {
  if (!Array.isArray(offsets)) return [];
  return [...new Set(offsets)]
    .filter((offset): offset is number => typeof offset === "number" && Number.isInteger(offset) && offset >= 1 && offset <= 6)
    .sort((a, b) => a - b);
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
