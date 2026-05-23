export const defaultCoachModel = "gpt-5-mini";

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
