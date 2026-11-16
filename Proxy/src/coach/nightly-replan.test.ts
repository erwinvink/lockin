import assert from "node:assert/strict";
import test from "node:test";
import { runCombinedWeekPipeline, type RunningPlannerGuidance } from "./plan-pipeline";
import { buildCoachContext } from "./planner/build-coach-context";
import type { CoachRequest, RunKind, RunningWeek, RunSummary } from "./planner/types";

// Nightly re-plans (01:30) for a steady athlete in Amsterdam, where local
// midnight is 23:00Z in winter, run through the pipeline with a scripted
// model: it keeps last night's plan when continuity says so and otherwise
// plans the athlete's usual week.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

type Pattern = Partial<Record<string, [kind: RunKind, km: number, climbM: number]>>;
type Athlete = { pattern: Pattern; runningDays: string[]; longRunDay: string };
type PlanDay = { date: string; kind: RunKind; km: number; climb: number };
type Model = (guidance: RunningPlannerGuidance, repair?: string[]) => RunningWeek["sessions"];

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const weekday = (date: string) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
const localMidnight = (date: string) => Date.parse(`${date}T00:00:00Z`) - 60 * 60 * 1000;

function patternDay(athlete: Athlete, date: string): PlanDay | null {
  const entry = athlete.pattern[weekday(date)];
  return entry ? { date, kind: entry[0], km: entry[1], climb: entry[2] } : null;
}

function ran(day: PlanDay): RunSummary {
  const hard = day.kind === "intervals" || day.kind === "tempo" || day.kind === "hills";
  return {
    completedAt: new Date(localMidnight(day.date) + 8 * 60 * 60 * 1000).toISOString(),
    distanceKm: day.km,
    movingSeconds: Math.round(day.km * (hard ? 300 : 370)),
    elevationGainM: day.climb,
    averageHr: hard ? 160 : 140,
    kind: day.kind
  };
}

/** The athlete's usual weeks, run as planned, from `from` up to the day before `until`. */
function usualWeeks(athlete: Athlete, from: string, until: string): RunSummary[] {
  const runs: RunSummary[] = [];
  for (let date = from; date < until; date = addDays(date, 1)) {
    const day = patternDay(athlete, date);
    if (day) runs.push(ran(day));
  }
  return runs;
}

function session(dayOffset: number, kind: RunKind, distanceKm: number, elevationMeters: number): RunningWeek["sessions"][number] {
  return {
    title: `${kind} run`,
    dayOffset,
    kind,
    purpose: "The usual week.",
    distanceKm,
    durationMinutes: Math.round(distanceKm * 6),
    elevationMeters,
    target: { type: "hr", low: 132, high: 145 },
    zone: "Zone 2",
    notes: []
  };
}

/** The 01:30 request for `today`: the runs so far, and last night's plan with its last days completed. */
function nightRequest(today: string, athlete: Athlete, history: RunSummary[], plan: PlanDay[]): CoachRequest {
  const weekStart = localMidnight(today);
  const offsets = [1, 2, 3, 4, 5, 6].filter((offset) => athlete.runningDays.includes(weekday(addDays(today, offset))));
  return {
    model: "test-model",
    timeZone: "Europe/Amsterdam",
    baseline: { pullUps: 10, pushUps: 40, plankSeconds: 90 },
    goals: { pullUps: 20, pushUps: 100, plankSeconds: 300 },
    profileNotes: "",
    weekStart: new Date(weekStart).toISOString(),
    // One strength day, today: no strength is left to plan.
    weeklySessions: 1,
    trainingDays: [weekday(today)],
    trainingDayOffsets: [],
    equipment: ["pullUpBar"],
    targetDate: "2027-12-01T00:00:00Z",
    trainingLogs: [],
    plannedSessions: plan
      .filter((day) => day.date >= addDays(today, -3))
      .map((day) => ({
        id: `run-${day.date}`,
        scheduledDate: new Date(localMidnight(day.date)).toISOString(),
        title: `${day.kind} run`,
        focus: "mixed",
        status: day.date < today ? "completed" : "planned",
        exercises: [],
        discipline: "running",
        runKind: day.kind,
        distanceKm: day.km,
        elevationMeters: day.climb,
        target: { type: "hr", low: 132, high: 145 }
      })),
    currentPlanGeneratedAt: new Date(localMidnight(addDays(today, -1)) + 1.5 * 60 * 60 * 1000).toISOString(),
    running: {
      raceGoal: { name: "Autumn Trail", raceDate: "2027-10-02T00:00:00Z", distanceKm: 60, elevationGainM: 2500 },
      baselineWeeklyKm: 40,
      longestRecentRunKm: Math.max(...Object.values(athlete.pattern).map((entry) => entry?.[1] ?? 0)),
      runningDays: athlete.runningDays,
      runningDayOffsets: offsets,
      longRunDay: athlete.longRunDay,
      longRunDayOffset: offsets.find((offset) => weekday(addDays(today, offset)) === athlete.longRunDay),
      recentRuns: history.filter((run) => Date.parse(run.completedAt) < weekStart)
    }
  };
}

async function replanNight(request: CoachRequest, model: Model) {
  const now = new Date(Date.parse(request.weekStart) + 1.5 * 60 * 60 * 1000);
  const context = buildCoachContext(request, now);
  const guidance: RunningPlannerGuidance[] = [];
  const repairs: string[][] = [];
  const result = await runCombinedWeekPipeline({
    context,
    now,
    generateRunning: async (next, repair) => {
      guidance.push(next);
      if (repair) repairs.push(repair.messages);
      return { ok: true, value: { summary: "The usual week.", safetyFlags: [], sessions: model(next, repair?.messages) } };
    },
    generateStrength: async () => ({
      ok: true,
      value: { summary: "Build: no strength day left this week.", contextState: context.readiness.state, safetyFlags: ["The week's only strength day is today."], sessions: [] }
    }),
    recordValidationFailure: async () => {}
  });
  return { result, guidance: guidance[0], repairs };
}

const ATHLETES: Record<string, Athlete> = {
  "Tuesday-Sunday, every running day used": {
    pattern: { tuesday: ["easy", 8, 60], wednesday: ["intervals", 8, 60], thursday: ["easy", 6, 40], saturday: ["long", 14, 200], sunday: ["recovery", 4, 20] },
    runningDays: ["tuesday", "wednesday", "thursday", "saturday", "sunday"],
    longRunDay: "saturday"
  },
  "Monday-Saturday selected, five used": {
    pattern: { monday: ["easy", 8, 60], tuesday: ["intervals", 8, 60], wednesday: ["easy", 6, 40], thursday: ["easy", 4, 20], saturday: ["long", 14, 200] },
    runningDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
    longRunDay: "saturday"
  },
  "four days, tempo on Wednesday": {
    pattern: { wednesday: ["tempo", 9, 60], thursday: ["easy", 9, 60], saturday: ["long", 15, 250], sunday: ["easy", 7, 40] },
    runningDays: ["wednesday", "thursday", "saturday", "sunday"],
    longRunDay: "saturday"
  },
  // Three hard runs in five. On Wednesday night the plan holds 3 of them in
  // 4 runs: only with today's run counted (5 runs) is that within the cap.
  "three hard runs in five": {
    pattern: { tuesday: ["intervals", 8, 60], wednesday: ["easy", 6, 40], thursday: ["tempo", 8, 60], saturday: ["long", 15, 200], sunday: ["easy", 6, 40] },
    runningDays: ["tuesday", "wednesday", "thursday", "saturday", "sunday"],
    longRunDay: "saturday"
  }
};

// Three weeks of nights from Monday 11 January: nothing changes, so every
// night keeps last night's plan, passes without a repair, and the weeks
// neither grow nor shrink.
test("three weeks of nightly re-plans keep the plan and the weekly km", async () => {
  const start = "2027-01-11";
  for (const [name, athlete] of Object.entries(ATHLETES)) {
    const history = usualWeeks(athlete, addDays(start, -56), start);
    let plan = [-3, -2, -1, 0, 1, 2, 3, 4, 5].flatMap((offset) => patternDay(athlete, addDays(start, offset)) ?? []);
    let ranKm = 0;
    for (let night = 0; night < 21; night += 1) {
      const today = addDays(start, night);
      const current = plan;
      const model: Model = (guidance) => {
        const keep = guidance.continuity?.keepUnlessChanged ?? false;
        return [1, 2, 3, 4, 5, 6].flatMap((offset) => {
          const date = addDays(today, offset);
          const day = (keep ? current.find((entry) => entry.date === date) : null) ?? patternDay(athlete, date);
          return day ? [session(offset, day.kind, day.km, day.climb)] : [];
        });
      };
      const { result, guidance, repairs } = await replanNight(nightRequest(today, athlete, history, plan), model);

      assert.equal(result.ok, true, `${name}, ${today}: ${JSON.stringify(result)}`);
      assert.equal(guidance.continuity?.keepUnlessChanged, true, `${name}, ${today}: ${guidance.continuity?.changeSignals.join(" ")}`);
      assert.equal(repairs.length, 0, `${name}, ${today}: ${repairs.flat().join(" ")}`);
      if (!result.ok) return;
      // The athlete runs today's planned run; tonight's plan takes the coming days.
      const todays = plan.find((day) => day.date === today);
      if (todays) {
        history.push(ran(todays));
        ranKm += todays.km;
      }
      plan = [
        ...plan.filter((day) => day.date <= today),
        ...result.runningWeek.sessions.map((entry) => ({ date: addDays(today, entry.dayOffset), kind: entry.kind, km: entry.distanceKm, climb: entry.elevationMeters }))
      ];
    }
    const weekKm = Object.values(athlete.pattern).reduce((sum, entry) => sum + (entry?.[1] ?? 0), 0);
    assert.equal(Math.round(ranKm * 10) / 10, 3 * weekKm, `${name}: three usual weeks`);
  }
});

// Whenever continuity is kept, the most the kept plan allows (each kept run
// grown 15% within its cap, the free running days at their most, inside the
// weekly cap, rounded down to 0.5 km) must reach the weekly-km floor. The
// scripted model takes that most but stops up to 0.5 km short (its longest
// run in whole km), which the estimate's margin absorbs: with the margin
// dropped, or runs rounded to 0.1 km, these 600 scenarios find misses.
test("continuity is kept only when the kept plan can reach the weekly-km floor (seeded fuzz)", async () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const order = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  let keptCases = 0;
  const misses: string[] = [];

  for (let scenario = 0; scenario < 600; scenario += 1) {
    const runningDays = [...order].sort(() => random() - 0.5).slice(0, 3 + Math.floor(random() * 4)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const longRunDay = runningDays[Math.floor(random() * runningDays.length)];
    const weekKm = 20 + Math.round(random() * 40);
    const others = runningDays.filter((day) => day !== longRunDay);
    const qualityDay = others.find((day) => Math.abs(order.indexOf(day) - order.indexOf(longRunDay)) % 6 > 1) ?? null;
    const pattern: Pattern = { [longRunDay]: ["long", Math.round(weekKm * 0.35), 150] };
    for (const day of others) pattern[day] = [day === qualityDay ? "intervals" : "easy", Math.max(3, Math.round((weekKm * 0.65) / others.length)), 60];
    const athlete: Athlete = { pattern, runningDays, longRunDay };
    const today = addDays("2027-01-11", Math.floor(random() * 7));
    // Last night's plan: the usual week scaled (eased or grown), the long run sometimes at its cap.
    const scale = 0.55 + random() * 0.6;
    const longAtCap = random() < 0.4;
    const plan = [-1, 0, 1, 2, 3, 4, 5].flatMap((offset) => {
      const day = patternDay(athlete, addDays(today, offset));
      if (!day) return [];
      const km = day.kind === "long" && longAtCap ? Math.floor(day.km * 1.15 * 2) / 2 : Math.max(3, Math.round(day.km * scale * 2) / 2);
      return [{ ...day, km }];
    });
    const request = nightRequest(today, athlete, usualWeeks(athlete, "2026-11-16", today), plan);
    const offsets = request.running!.runningDayOffsets;
    const longOffset = request.running!.longRunDayOffset;

    let kept = false;
    const model: Model = (guidance) => {
      kept = guidance.continuity?.keepUnlessChanged ?? false;
      const guardrails = guidance.guardrails as { longRun?: { capKm: number }; weeklyVolume?: { capKm?: number }; floors?: { todayRun?: { distanceKm: number } | null } };
      const cap = guardrails.longRun?.capKm ?? 99;
      const budget = (guardrails.weeklyVolume?.capKm ?? 999) - (guardrails.floors?.todayRun?.distanceKm ?? 0);
      const sessions: RunningWeek["sessions"] = [];
      for (const day of plan.filter((entry) => entry.date > today)) {
        const offset = Math.round((Date.parse(`${day.date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY_MS);
        const usual = pattern[weekday(day.date)]?.[1] ?? day.km;
        sessions.push(session(offset, day.kind, kept ? Math.min(day.km * 1.15, cap) : usual, day.climb));
      }
      // Kept: the free running days at their most, up to 5 runs.
      const longKm = sessions.find((entry) => entry.dayOffset === longOffset)?.distanceKm ?? cap;
      for (let offset = 1; offset <= 6 && sessions.length < Math.min(5, offsets.length); offset += 1) {
        if (!offsets.includes(offset) || sessions.some((entry) => entry.dayOffset === offset)) continue;
        const usual = pattern[weekday(addDays(today, offset))];
        const kind = usual?.[0] ?? "easy";
        sessions.push(session(offset, kind, kept ? (offset === longOffset ? cap : Math.min(cap, longKm)) : usual?.[1] ?? 5, 40));
      }
      sessions.sort((a, b) => a.dayOffset - b.dayOffset);
      const total = sessions.reduce((sum, entry) => sum + entry.distanceKm, 0);
      if (total > budget) {
        for (const entry of sessions) {
          if (entry.kind === "easy" || entry.kind === "recovery") entry.distanceKm = Math.max(3, entry.distanceKm - (total - budget) / sessions.length);
        }
      }
      for (const entry of sessions) entry.distanceKm = Math.floor(entry.distanceKm * 2 + 1e-9) / 2;
      // Like a model that likes round numbers: the longest run in whole km.
      const longest = sessions.reduce<RunningWeek["sessions"][number] | null>((max, entry) => (!max || entry.distanceKm > max.distanceKm ? entry : max), null);
      if (longest) longest.distanceKm = Math.floor(longest.distanceKm);
      return sessions;
    };
    const { repairs } = await replanNight(request, model);

    if (!kept) continue;
    keptCases += 1;
    const floorMessage = repairs[0]?.find((message) => message.includes("below this week's floor"));
    if (floorMessage) misses.push(`${today}, ${runningDays.join("/")}, long ${longRunDay}, ${weekKm} km, scale ${scale.toFixed(2)}: ${floorMessage}`);
  }

  assert.ok(keptCases >= 300, `enough kept cases to say something (${keptCases})`);
  assert.deepEqual(misses, []);
});
