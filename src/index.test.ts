import { describe, it, expect, vi } from "vitest";
import { createRecipe, hmToMinutes, isWithinWindow } from "./index.js";

// ============================================================
// Pure window helpers
// ============================================================

describe("hmToMinutes", () => {
  it("parses HH:MM into minutes-of-day", () => {
    expect(hmToMinutes("00:00")).toBe(0);
    expect(hmToMinutes("21:00")).toBe(21 * 60);
    expect(hmToMinutes("06:30")).toBe(6 * 60 + 30);
    expect(hmToMinutes("9:05")).toBe(9 * 60 + 5);
  });
  it("returns NaN for malformed input", () => {
    expect(Number.isNaN(hmToMinutes("nope"))).toBe(true);
    expect(Number.isNaN(hmToMinutes(""))).toBe(true);
  });
});

describe("isWithinWindow", () => {
  it("same-day window [09:00, 17:00): inclusive start, exclusive end", () => {
    const s = 9 * 60,
      e = 17 * 60;
    expect(isWithinWindow(8 * 60, s, e)).toBe(false);
    expect(isWithinWindow(9 * 60, s, e)).toBe(true);
    expect(isWithinWindow(12 * 60, s, e)).toBe(true);
    expect(isWithinWindow(17 * 60, s, e)).toBe(false);
    expect(isWithinWindow(20 * 60, s, e)).toBe(false);
  });
  it("midnight-crossing window [21:00, 06:00)", () => {
    const s = 21 * 60,
      e = 6 * 60;
    expect(isWithinWindow(20 * 60, s, e)).toBe(false);
    expect(isWithinWindow(21 * 60, s, e)).toBe(true);
    expect(isWithinWindow(23 * 60, s, e)).toBe(true);
    expect(isWithinWindow(0, s, e)).toBe(true); // midnight
    expect(isWithinWindow(5 * 60, s, e)).toBe(true);
    expect(isWithinWindow(6 * 60, s, e)).toBe(false);
    expect(isWithinWindow(12 * 60, s, e)).toBe(false);
  });
  it("zero-width window is never active", () => {
    expect(isWithinWindow(10 * 60, 10 * 60, 10 * 60)).toBe(false);
  });
});

// ============================================================
// Mock RecipeContext harness
// ============================================================

const baseParams = { zone: "z1", equipment: "eq1", dataKey: "state", watchValue: "open" };

function makeCtx(initialValue: unknown) {
  const store = new Map<string, unknown>();
  let value = initialValue;
  let handler: ((e: Record<string, unknown>) => void) | null = null;
  const ctx = {
    eventBus: {
      onType(type: string, h: (e: Record<string, unknown>) => void) {
        if (type === "equipment.data.changed") handler = h;
        return () => {};
      },
    },
    equipmentManager: {
      getByIdWithDetails: () => ({
        name: "Eq",
        zoneId: "z1",
        dataBindings: [{ alias: "state", value }],
        orderBindings: [],
      }),
    },
    zoneManager: { getById: (id: string) => ({ id, name: "Zone" }) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    state: {
      get: (k: string) => (store.has(k) ? store.get(k) : null),
      set: (k: string, v: unknown) => void store.set(k, v),
      delete: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    log: () => {},
    helpers: {
      parseDuration: (v: unknown) => {
        const m = /^(\d+)(s|m|h)$/.exec(String(v));
        if (!m) throw new Error(`bad duration: ${String(v)}`);
        const n = Number(m[1]);
        return m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60000 : n * 3600000;
      },
      formatDuration: (ms: number) => `${ms}ms`,
    },
  };
  return {
    ctx: ctx as unknown as Parameters<ReturnType<typeof createRecipe>["createInstance"]>[1],
    getState: (k: string) => (store.has(k) ? store.get(k) : null),
    setValue(v: unknown) {
      value = v;
      handler?.({ equipmentId: "eq1", alias: "state", value: v });
    },
  };
}

// ============================================================
// State machine — permanent monitoring (no window)
// ============================================================

describe("state machine (no window)", () => {
  it("alarms immediately on entering the watched state and clears on leaving", () => {
    const h = makeCtx("closed");
    const inst = createRecipe().createInstance({ ...baseParams }, h.ctx);
    expect(h.getState("alarm")).toBe(false); // closed → no alarm

    h.setValue("open");
    expect(h.getState("alarm")).toBe(true); // open → alarm

    h.setValue("closed");
    expect(h.getState("alarm")).toBe(false); // closed → cleared
    inst.stop();
  });
});

// ============================================================
// State machine — check window gates the alarm
// ============================================================

describe("state machine (check window 21:00 → 06:00)", () => {
  it("alarms when already in the watched state inside the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T22:00:00"));
    const h = makeCtx("open");
    const inst = createRecipe().createInstance(
      { ...baseParams, checkStart: "21:00", checkEnd: "06:00" },
      h.ctx,
    );
    expect(h.getState("alarm")).toBe(true);
    inst.stop();
    vi.useRealTimers();
  });

  it("does NOT alarm in the watched state outside the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T12:00:00"));
    const h = makeCtx("open");
    const inst = createRecipe().createInstance(
      { ...baseParams, checkStart: "21:00", checkEnd: "06:00" },
      h.ctx,
    );
    expect(h.getState("alarm")).toBe(false);
    inst.stop();
    vi.useRealTimers();
  });
});

// ============================================================
// Validation
// ============================================================

describe("validate", () => {
  const recipe = createRecipe();
  const vctx = {
    zoneManager: { getById: () => ({ id: "z1", name: "Z" }) },
    equipmentManager: {
      getByIdWithDetails: () => ({
        name: "Eq",
        zoneId: "z1",
        dataBindings: [{ alias: "state" }],
        orderBindings: [],
      }),
    },
    helpers: {
      parseDuration: (v: unknown) => {
        if (!/^\d+[smh]$/.test(String(v))) throw new Error("bad");
        return 1;
      },
    },
  } as unknown as Parameters<typeof recipe.validate>[1];

  it("accepts a bare config (permanent monitoring, no delay/repeat/window)", () => {
    expect(() => recipe.validate({ ...baseParams }, vctx)).not.toThrow();
  });
  it("rejects a half-defined window (start without end)", () => {
    expect(() => recipe.validate({ ...baseParams, checkStart: "21:00" }, vctx)).toThrow(/window/i);
  });
  it("accepts a full window", () => {
    expect(() =>
      recipe.validate({ ...baseParams, checkStart: "21:00", checkEnd: "06:00" }, vctx),
    ).not.toThrow();
  });
  it("rejects an invalid window time", () => {
    expect(() =>
      recipe.validate({ ...baseParams, checkStart: "9pm", checkEnd: "06:00" }, vctx),
    ).toThrow(/time/i);
  });
});
