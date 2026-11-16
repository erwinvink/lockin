import assert from "node:assert/strict";
import test from "node:test";
import { plural, round1 } from "./numbers";

test("round1 keeps a value stored just below a half on the side it means", () => {
  assert.equal(round1(45 * 1.15), 51.8);
  assert.equal(round1(22.04), 22);
});

// Final review item 10: athlete-facing text says "1 day" and "4 days", never "day(s)".
test("plural writes the count with the right noun form", () => {
  assert.equal(plural(1, "day"), "1 day");
  assert.equal(plural(4, "day"), "4 days");
  assert.equal(plural(0, "week"), "0 weeks");
  assert.equal(plural(1, "loading week"), "1 loading week");
  assert.equal(plural(2, "strength session"), "2 strength sessions");
});
