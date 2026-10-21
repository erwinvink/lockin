export const defaultCoachModel = "gpt-6.1-sol";

// Models the proxy will spend the OpenAI key on: the default plus the app's
// model catalog. COACH_ALLOWED_MODELS (comma-separated) replaces this list.
const builtInAllowedModels = [defaultCoachModel, "gpt-5.5", "gpt-5-mini"];

type OpenAIModelListItem = {
  id?: unknown;
  created?: unknown;
};

const excludedModelNameParts = [
  "audio",
  "babbage",
  "dall-e",
  "davinci",
  "embedding",
  "image",
  "moderation",
  "realtime",
  "sora",
  "transcribe",
  "tts",
  "whisper"
];

export function normalizeRequestedModel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const model = value.trim();
  return model.length > 0 ? model : null;
}

export function allowedCoachModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env.COACH_ALLOWED_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
  const list = configured.length > 0 ? configured : builtInAllowedModels;
  // The default is always usable: it is what everything else falls back to.
  return Array.from(new Set([defaultCoachModel, ...list]));
}

/** The requested model when it is allowed, otherwise the default (never an error). */
export function resolveCoachModel(value: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const requested = normalizeRequestedModel(value);
  return requested && allowedCoachModels(env).includes(requested) ? requested : defaultCoachModel;
}

/** The models to offer the app: the default first, then allowed ones OpenAI lists. */
export function filterAllowedModels(models: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const allowed = new Set(allowedCoachModels(env));
  return Array.from(new Set([defaultCoachModel, ...models.filter((model) => allowed.has(model))]));
}

export function pickTextModelIDs(models: unknown[]): string[] {
  const candidates = models
    .filter((model): model is OpenAIModelListItem => Boolean(model) && typeof model === "object")
    .filter((model): model is { id: string; created?: unknown } => typeof model.id === "string")
    .filter((model) => isLikelyResponsesTextModel(model.id))
    .sort((left, right) => {
      const leftCreated = typeof left.created === "number" ? left.created : 0;
      const rightCreated = typeof right.created === "number" ? right.created : 0;
      return rightCreated - leftCreated || left.id.localeCompare(right.id);
    })
    .map((model) => model.id);

  return Array.from(new Set(candidates));
}

export function withDefaultCoachModel(models: string[]): string[] {
  if (models.includes(defaultCoachModel)) {
    return models;
  }

  return [defaultCoachModel, ...models];
}

function isLikelyResponsesTextModel(modelID: string): boolean {
  const lowercased = modelID.toLowerCase();

  if (excludedModelNameParts.some((part) => lowercased.includes(part))) {
    return false;
  }

  return /^(gpt-|o\d|chatgpt-|codex-)/.test(lowercased);
}
