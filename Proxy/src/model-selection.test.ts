import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedCoachModels,
  defaultCoachModel,
  filterAllowedModels,
  normalizeRequestedModel,
  pickTextModelIDs,
  resolveCoachModel,
  withDefaultCoachModel
} from "./model-selection";

test("normalizes explicit model IDs", () => {
  assert.equal(normalizeRequestedModel(" gpt-5.5 "), "gpt-5.5");
  assert.equal(normalizeRequestedModel(""), null);
  assert.equal(normalizeRequestedModel(undefined), null);
});

test("keeps likely text models and removes specialized models", () => {
  const models = pickTextModelIDs([
    { id: "text-embedding-3-large", created: 3 },
    { id: "gpt-5-mini", created: 2 },
    { id: "gpt-5.5", created: 4 },
    { id: "gpt-image-1", created: 5 },
    { id: "o4-mini", created: 1 },
    { id: "gpt-4o-mini-transcribe", created: 6 }
  ]);

  assert.deepEqual(models, ["gpt-5.5", "gpt-5-mini", "o4-mini"]);
});

test("adds the default coach model when the OpenAI list omits it", () => {
  assert.deepEqual(withDefaultCoachModel(["gpt-5.5"]), [defaultCoachModel, "gpt-5.5"]);
  assert.deepEqual(withDefaultCoachModel([defaultCoachModel, "gpt-5.5"]), [defaultCoachModel, "gpt-5.5"]);
});

test("the coach runs on gpt-6.1-sol by default", () => {
  assert.equal(defaultCoachModel, "gpt-6.1-sol");
});

test("allowed models pass and anything else falls back to the default (S5)", () => {
  assert.deepEqual(allowedCoachModels({}), ["gpt-6.1-sol", "gpt-5.5", "gpt-5-mini"]);
  assert.equal(resolveCoachModel(" gpt-5.5 ", {}), "gpt-5.5");
  assert.equal(resolveCoachModel("gpt-5-mini", {}), "gpt-5-mini");
  assert.equal(resolveCoachModel("o1-pro", {}), defaultCoachModel);
  assert.equal(resolveCoachModel("", {}), defaultCoachModel);
  assert.equal(resolveCoachModel(undefined, {}), defaultCoachModel);
  assert.equal(resolveCoachModel(42, {}), defaultCoachModel);
});

test("COACH_ALLOWED_MODELS replaces the built-in allow-list (S5)", () => {
  const env = { COACH_ALLOWED_MODELS: " gpt-5.5, o4-mini ,," };
  assert.deepEqual(allowedCoachModels(env), [defaultCoachModel, "gpt-5.5", "o4-mini"]);
  assert.equal(resolveCoachModel("o4-mini", env), "o4-mini");
  assert.equal(resolveCoachModel("gpt-5-mini", env), defaultCoachModel);
});

test("the model list offered to the app only contains allowed models (S5)", () => {
  assert.deepEqual(filterAllowedModels(["gpt-5.5", "o1-pro", "gpt-5-mini", "gpt-6.1-sol"], {}), [
    "gpt-6.1-sol",
    "gpt-5.5",
    "gpt-5-mini"
  ]);
  assert.deepEqual(filterAllowedModels(["o1-pro"], {}), [defaultCoachModel]);
});
