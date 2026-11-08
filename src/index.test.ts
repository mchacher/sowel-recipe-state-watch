import { describe, it, expect, vi } from "vitest";
import {
  createRecipe,
  hmToMinutes,
  isWithinWindow,
  watchLabel,
  formatDelay,
  buildSummary,
} from "./index.js";

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

function makeCtx(initialValue: unknown, category?: string) {
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
        dataBindings: [{ alias: "state", value, category }],
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

  it("exposes only alarm + alarmSince (no alarmCount / currentValue)", () => {
    const h = makeCtx("closed");
    const inst = createRecipe().createInstance({ ...baseParams }, h.ctx);
    h.setValue("open");
    expect(h.getState("alarm")).toBe(true);
    expect(typeof h.getState("alarmSince")).toBe("string");
    expect(h.getState("alarmCount")).toBeNull();
    expect(h.getState("currentValue")).toBeNull();
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

// ============================================================
// Summary — what the instance watches (sowel#1165)
// ============================================================

describe("watchLabel", () => {
  it("labels UPS statuses like the UPS card does", () => {
    expect(watchLabel("status", "on_battery", "ups_status")).toBe("Sur batterie");
    expect(watchLabel("status", "low_battery", "ups_status")).toBe("Batterie faible");
    expect(watchLabel("status", "offline", "ups_status")).toBe("Sortie coupée");
  });
  it("labels booleans by category, contacts reading false as open", () => {
    expect(watchLabel("state", "false", "light_state")).toBe("Éteint");
    expect(watchLabel("contact", "false", "contact_door")).toBe("Ouvert");
    expect(watchLabel("leak", "true", "water_leak")).toBe("Fuite d'eau");
  });
  it("labels gate and appliance states", () => {
    expect(watchLabel("state", "open", "gate_state")).toBe("Ouvert");
    expect(watchLabel("state", "ready", "appliance_state")).toBe("Prêt");
  });
  it("reads a stove fault code on a generic binding", () => {
    expect(watchLabel("stoveState", "error_A02", "generic")).toBe("Erreur A02");
    expect(watchLabel("stoveState", "off", "generic")).toBe("Éteint");
  });
  it("falls back to « key : value » for an unknown value", () => {
    expect(watchLabel("state", "half_open", "gate_state")).toBe("state : half_open");
    expect(watchLabel("mode", "eco")).toBe("mode : eco");
  });
});

describe("formatDelay", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDelay(30_000)).toBe("30 s");
    expect(formatDelay(60_000)).toBe("1 min");
    expect(formatDelay(10 * 60_000)).toBe("10 min");
    expect(formatDelay(2 * 3_600_000)).toBe("2 h");
    expect(formatDelay(90 * 60_000)).toBe("1 h 30");
  });
});

describe("buildSummary", () => {
  it("leads with the watched state, then the delay and the window", () => {
    expect(buildSummary({ label: "Ouvert", delayMs: 600_000, window: null, alarm: false })).toBe(
      "Ouvert · après 10 min",
    );
    expect(
      buildSummary({
        label: "Ouvert",
        delayMs: 0,
        window: { start: "21:00", end: "05:00" },
        alarm: false,
      }),
    ).toBe("Ouvert · 21:00–05:00");
    expect(buildSummary({ label: "Batterie faible", delayMs: null, window: null, alarm: false })).toBe(
      "Batterie faible",
    );
  });
  it("shows the live alarm in place of the settings", () => {
    expect(buildSummary({ label: "Sur batterie", delayMs: 60_000, window: null, alarm: true })).toBe(
      "Sur batterie · en alarme",
    );
  });
});

describe("state.summary on an instance", () => {
  it("is set at start, follows the alarm, and stays without it after stop", () => {
    vi.useFakeTimers();
    const h = makeCtx("online", "ups_status");
    const inst = createRecipe().createInstance(
      { ...baseParams, dataKey: "state", watchValue: "on_battery", delay: "1m" },
      h.ctx,
    );
    expect(h.getState("summary")).toBe("Sur batterie · après 1 min");

    h.setValue("on_battery");
    expect(h.getState("summary")).toBe("Sur batterie · après 1 min"); // grace, not yet alarmed
    vi.advanceTimersByTime(60_000);
    expect(h.getState("alarm")).toBe(true);
    expect(h.getState("summary")).toBe("Sur batterie · en alarme");

    h.setValue("online");
    expect(h.getState("summary")).toBe("Sur batterie · après 1 min");

    h.setValue("on_battery");
    vi.advanceTimersByTime(60_000);
    inst.stop();
    expect(h.getState("summary")).toBe("Sur batterie · après 1 min");
    vi.useRealTimers();
  });

  it("reflects an alarm already active when the instance starts", () => {
    const h = makeCtx("open", "gate_state");
    const inst = createRecipe().createInstance({ ...baseParams }, h.ctx);
    expect(h.getState("summary")).toBe("Ouvert · en alarme");
    inst.stop();
  });

  it("uses the generic form when the binding carries no known category", () => {
    const h = makeCtx("closed");
    const inst = createRecipe().createInstance({ ...baseParams, watchValue: "ajar" }, h.ctx);
    expect(h.getState("summary")).toBe("state : ajar");
    inst.stop();
  });
});
