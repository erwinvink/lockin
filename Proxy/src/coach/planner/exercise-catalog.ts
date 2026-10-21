import type { ExerciseKind } from "./types";

/**
 * Every exercise the planner may prescribe, with its equipment needs. Mirrors
 * skills/fitness-coach-planner/references/exercise-library.json, the weekly
 * plan schema enum and the app's ExerciseKind enum (a test keeps all four
 * identical, so a planned name always exists and the app can show and log it).
 */
export const EXERCISE_CATALOG: Record<ExerciseKind, { title: string; requiredEquipment: string[]; anyOfEquipment?: string[] }> = {
  pullUp: { title: "Pull-up", requiredEquipment: ["pullUpBar"] },
  negativePullUp: { title: "Negative pull-up", requiredEquipment: ["pullUpBar"] },
  bandAssistedPullUp: { title: "Band-assisted pull-up", requiredEquipment: ["pullUpBar", "resistanceBand"] },
  invertedRow: { title: "Inverted row", requiredEquipment: [] },
  scapularPull: { title: "Scapular pull", requiredEquipment: ["pullUpBar"] },
  deadHang: { title: "Dead hang", requiredEquipment: ["pullUpBar"] },
  archerPullUp: { title: "Archer pull-up", requiredEquipment: ["pullUpBar"] },
  lSitPullUp: { title: "L-sit pull-up", requiredEquipment: ["pullUpBar"] },
  weightedPullUp: { title: "Weighted pull-up", requiredEquipment: ["pullUpBar"], anyOfEquipment: ["dumbbells", "backpack"] },
  pushUp: { title: "Push-up", requiredEquipment: [] },
  inclinePushUp: { title: "Incline push-up", requiredEquipment: [] },
  kneePushUp: { title: "Knee push-up", requiredEquipment: [] },
  pikePushUp: { title: "Pike push-up", requiredEquipment: [] },
  diamondPushUp: { title: "Diamond push-up", requiredEquipment: [] },
  declinePushUp: { title: "Decline push-up", requiredEquipment: [] },
  deficitPushUp: { title: "Deficit push-up", requiredEquipment: [] },
  archerPushUp: { title: "Archer push-up", requiredEquipment: [] },
  weightedPushUp: { title: "Weighted push-up", requiredEquipment: [], anyOfEquipment: ["backpack"] },
  plank: { title: "Plank", requiredEquipment: [] },
  sidePlank: { title: "Side plank", requiredEquipment: [] },
  longLeverPlank: { title: "Long-lever plank", requiredEquipment: [] },
  rkcPlank: { title: "RKC plank", requiredEquipment: [] },
  weightedPlank: { title: "Weighted plank", requiredEquipment: [], anyOfEquipment: ["backpack", "dumbbells"] },
  hollowHold: { title: "Hollow hold", requiredEquipment: [] },
  shoulderMobility: { title: "Shoulder mobility", requiredEquipment: [] }
};

export const EXERCISE_KINDS = Object.keys(EXERCISE_CATALOG) as ExerciseKind[];

/**
 * The exercises app versions before the exercise ladders know. Those apps
 * reject a plan with any other name, so a request without
 * `supportedExercises` is planned with these only.
 */
export const LEGACY_EXERCISE_KINDS: ExerciseKind[] = [
  "pullUp",
  "pushUp",
  "plank",
  "scapularPull",
  "hollowHold",
  "inclinePushUp",
  "pikePushUp",
  "deadHang",
  "shoulderMobility"
];

/** The exercises this client can show and log: what it says it supports, else the legacy list. */
export function supportedExercisesFor(requested: unknown): ExerciseKind[] {
  if (!Array.isArray(requested)) return [...LEGACY_EXERCISE_KINDS];
  const supported = EXERCISE_KINDS.filter((kind) => requested.includes(kind));
  return supported.length > 0 ? supported : [...LEGACY_EXERCISE_KINDS];
}

/** The weekly plan schema with the exercise enum narrowed to what the client supports. */
export function schemaForExercises(schema: Record<string, unknown>, exercises: ExerciseKind[]): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(schema)) as {
    properties?: { sessions?: { items?: { properties?: { exercises?: { items?: { properties?: { exercise?: { enum?: string[] } } } } } } } };
  };
  const exercise = copy.properties?.sessions?.items?.properties?.exercises?.items?.properties?.exercise;
  if (exercise?.enum) exercise.enum = EXERCISE_KINDS.filter((kind) => exercises.includes(kind));
  return copy as Record<string, unknown>;
}

export function isExerciseKind(value: unknown): value is ExerciseKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(EXERCISE_CATALOG, value);
}

/**
 * Why the athlete cannot do this exercise with the listed equipment, or null.
 * An empty equipment list (never filled in) is not checked.
 */
export function missingEquipment(exercise: ExerciseKind, equipment: string[]): string | null {
  if (equipment.length === 0) return null;
  const entry = EXERCISE_CATALOG[exercise];
  const missing = entry.requiredEquipment.filter((item) => !equipment.includes(item));
  const anyOf = entry.anyOfEquipment ?? [];
  const needsOneOf = anyOf.length > 0 && !anyOf.some((item) => equipment.includes(item));
  if (missing.length === 0 && !needsOneOf) return null;
  const needs = [
    ...missing.map(equipmentName),
    ...(needsOneOf ? [anyOf.map(equipmentName).join(" or ")] : [])
  ].join(" and ");
  return `${entry.title} needs ${needs}`;
}

/** The ladder step for each goal metric at the athlete's current level (see selectionRules in the library). */
export function exerciseLadder(
  best: { pullUps: number | null; pushUps: number | null; plankSeconds: number | null },
  equipment: string[],
  supported: ExerciseKind[] = EXERCISE_KINDS
): Record<string, string> | null {
  // An app that predates the ladders cannot show the variants.
  if (!supported.includes("negativePullUp")) return null;
  const has = (item: string) => equipment.length === 0 || equipment.includes(item);
  const pull = best.pullUps ?? 0;
  const push = best.pushUps ?? 0;
  const plank = best.plankSeconds ?? 0;
  const pullStep = !has("pullUpBar")
    ? "No pull-up bar: invertedRow under a sturdy table or low bar for pulling volume."
    : pull < 3
      ? `Current max ${pull}: negativePullUp${has("resistanceBand") ? ", bandAssistedPullUp" : ""}, invertedRow, scapularPull and deadHang; full pullUp only as singles.`
      : pull <= 8
        ? `Current max ${pull}: submaximal pullUp sets inside the cap, negativePullUp as a finisher, invertedRow${has("resistanceBand") ? " or bandAssistedPullUp" : ""} for volume.`
        : pull <= 12
          ? `Current max ${pull}: pullUp volume; archerPullUp or lSitPullUp in small doses.`
          : `Current max ${pull}: one pullUp volume day, plus ${has("dumbbells") || has("backpack") ? "weightedPullUp, " : ""}archerPullUp or lSitPullUp for strength.`;
  const pushStep = push < 10
    ? `Current max ${push}: inclinePushUp and kneePushUp for volume; full pushUp in small sets.`
    : push <= 25
      ? `Current max ${push}: full pushUp sets; inclinePushUp for extra volume.`
      : push <= 40
        ? `Current max ${push}: full pushUp sets; diamondPushUp or declinePushUp for variation; pikePushUp as support.`
        : `Current max ${push}: one high-rep pushUp day, plus declinePushUp, deficitPushUp, archerPushUp${has("backpack") ? " or weightedPushUp" : ""} instead of ever more reps.`;
  const plankStep = plank < 30
    ? `Current max ${plank} s: short plank holds (15-20 s) and hollowHold.`
    : plank <= 120
      ? `Current max ${plank} s: plank holds inside the cap; sidePlank for lateral core.`
      : `Current max ${plank} s: longLeverPlank, rkcPlank${has("backpack") || has("dumbbells") ? " or weightedPlank" : ""} instead of longer holds; one plank hold a week for the goal.`;
  return { pullUps: pullStep, pushUps: pushStep, plankSeconds: plankStep };
}

function equipmentName(item: string): string {
  switch (item) {
    case "pullUpBar": return "a pull-up bar";
    case "resistanceBand": return "a resistance band";
    case "dumbbells": return "dumbbells";
    case "backpack": return "a loaded backpack";
    case "dipBars": return "dip bars";
    case "yogaMat": return "a yoga mat";
    default: return item;
  }
}
