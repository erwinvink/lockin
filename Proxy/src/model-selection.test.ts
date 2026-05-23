import assert from "node:assert/strict";
import test from "node:test";
import { defaultCoachModel, normalizeRequestedModel, pickTextModelIDs, withDefaultCoachModel } from "./model-selection";

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
