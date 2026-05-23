import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCoachContext } from "./coach/skills/fitness-coach-planner/scripts/build-coach-context";
import { validateWeeklyPlan } from "./coach/skills/fitness-coach-planner/scripts/validate-week-plan";
import type { CoachRequest, WeeklyPlan } from "./coach/skills/fitness-coach-planner/scripts/types";

const port = Number(process.env.PORT ?? 8787);
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";
const skillRoot = join(process.cwd(), "src", "coach", "skills", "fitness-coach-planner");

createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      writeJSON(res, 200, { ok: true, hasApiKey: Boolean(apiKey), model });
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
    const skill = await loadSkillBundle();
    const context = buildCoachContext(payload);

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
            content: JSON.stringify({ coachContext: context })
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
      res.writeHead(response.status, { "content-type": "application/json" }).end(await response.text());
      return;
    }

    const json = await response.json();
    const outputText = extractOutputText(json);
    const plan = JSON.parse(outputText) as WeeklyPlan;
    const validation = validateWeeklyPlan(plan, context);

    if (!validation.accepted) {
      writeJSON(res, 422, {
        error: "Generated plan failed local validation.",
        messages: validation.messages,
        contextState: context.readiness.state
      });
      return;
    }

    res.writeHead(200, { "content-type": "application/json" }).end(outputText);
  } catch (error) {
    writeJSON(res, 500, { error: error instanceof Error ? error.message : "Unknown proxy error" });
  }
}).listen(port, () => {
  console.log(`Fitness coach proxy listening on http://127.0.0.1:${port}`);
});

async function loadSkillBundle() {
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
