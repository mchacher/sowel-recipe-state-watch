// ============================================================
// State-Watch Recipe — external package
// ============================================================

// Minimal types for RecipeContext (injected at runtime by Sowel core)
interface RecipeContext {
  eventBus: {
    onType(type: string, handler: (event: Record<string, unknown>) => void): () => void;
  };
  equipmentManager: {
    getByIdWithDetails(id: string): {
      name: string;
      zoneId?: string;
      dataBindings: Array<{ alias: string; value?: unknown; category?: string }>;
      orderBindings: Array<{ alias: string; enumValues?: string[] }>;
    } | null;
  };
  zoneManager: {
    getById(id: string): { id: string; name: string } | null;
  };
  logger: {
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
    debug(obj: Record<string, unknown>, msg?: string): void;
  };
  state: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    clear(): void;
  };
  log: (message: string, level?: "info" | "warn" | "error") => void;
  helpers: {
    parseDuration(value: unknown): number;
    formatDuration(ms: number): string;
  };
}

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type: "zone" | "equipment" | "number" | "duration" | "time" | "boolean" | "text" | "data-key";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  constraints?: {
    equipmentType?: string | string[];
    min?: number;
    max?: number;
  };
  group?: string;
}

interface RecipeLangPack {
  name: string;
  description: string;
  slots?: Record<string, { name: string; description: string }>;
  groups?: Record<string, string>;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  actions?: unknown[];
  i18n?: Record<string, RecipeLangPack>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(
    params: Record<string, unknown>,
    ctx: RecipeContext,
  ): { stop(): void; onAction?(action: string, payload?: Record<string, unknown>): void };
}

// ============================================================
// Helper: compute ms until next occurrence of HH:MM today/tomorrow
// ============================================================

function msUntilNextOccurrence(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  const now = new Date();
  const target = new Date();
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

/** Minutes-of-day for an "HH:MM" string. NaN if malformed. */
export function hmToMinutes(timeStr: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Is `nowMinutes` inside the window [startMin, endMin)? Supports a window that
 * crosses midnight (start > end, e.g. 21:00 to 06:00). A zero-width window
 * (start === end) is never active.
 */
export function isWithinWindow(nowMinutes: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return false;
  if (startMin < endMin) return nowMinutes >= startMin && nowMinutes < endMin;
  return nowMinutes >= startMin || nowMinutes < endMin;
}

// ============================================================
// Summary — what this instance watches (sowel#1165)
// ============================================================

/**
 * Readable labels for a watched value, keyed by the binding's data category,
 * then by the raw value as the recipe compares it (`String(value)`). They
 * mirror the labels the Sowel UI shows for the same values, so the recipe row
 * reads like the equipment card. French, like the summaries of the other
 * recipes: the recipe context exposes no user language.
 */
const CATEGORY_VALUE_LABELS: Record<string, Record<string, string>> = {
  ups_status: {
    online: "Sur secteur",
    on_battery: "Sur batterie",
    bypass: "By-pass",
    overload: "Surcharge",
    low_battery: "Batterie faible",
    offline: "Sortie coupée",
  },
  gate_state: { open: "Ouvert", closed: "Fermé" },
  // Contact convention: false = open.
  contact_door: { false: "Ouvert", true: "Fermé" },
  contact_window: { false: "Ouvert", true: "Fermé" },
  light_state: { true: "Allumé", false: "Éteint" },
  motion: { true: "Mouvement détecté", false: "Aucun mouvement" },
  water_leak: { true: "Fuite d'eau", false: "Pas de fuite" },
  smoke: { true: "Fumée détectée", false: "Pas de fumée" },
  appliance_state: { ready: "Prêt", running: "En marche", paused: "En pause" },
};

/** Labels keyed by data alias, for data whose category is `generic`. */
const ALIAS_VALUE_LABELS: Record<string, Record<string, string>> = {
  stoveState: { off: "Éteint", running: "En marche", standby: "Veille", error: "Erreur" },
};

/**
 * A short, human line naming what is watched: « Sur batterie », « Erreur A02 »,
 * or « state : ready » when the value has no known label.
 */
export function watchLabel(dataKey: string, watchValue: string, category?: string): string {
  const byCategory = category ? CATEGORY_VALUE_LABELS[category]?.[watchValue] : undefined;
  if (byCategory) return byCategory;
  const byAlias = ALIAS_VALUE_LABELS[dataKey]?.[watchValue];
  if (byAlias) return byAlias;
  // Stove fault codes (`error_A01`…`error_A20`, MCZ plugin).
  const err = /^error_(.+)$/i.exec(watchValue);
  if (err) return `Erreur ${err[1]}`;
  return `${dataKey} : ${watchValue}`;
}

/** « 30 s », « 10 min », « 2 h », « 1 h 30 ». */
export function formatDelay(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
}

/**
 * The instance's one-line summary. The watched state always leads, so that
 * two instances on one equipment read apart; then the live alarm, or else the
 * delay and the check window that set this instance apart from a sibling.
 */
export function buildSummary(opts: {
  label: string;
  delayMs: number | null;
  window: { start: string; end: string } | null;
  alarm: boolean;
}): string {
  const parts = [opts.label];
  if (opts.alarm) {
    parts.push("en alarme");
  } else {
    if (opts.delayMs !== null && opts.delayMs > 0) parts.push(`après ${formatDelay(opts.delayMs)}`);
    if (opts.window) parts.push(`${opts.window.start}–${opts.window.end}`);
  }
  return parts.join(" · ");
}

// ============================================================
// Recipe Definition
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "state-watch",
    name: "State Watch",
    description:
      "Monitor an equipment data key and raise an alarm while the value stays in a watched state. Permanent by default, with an optional delay and time window. Re-notification is configured on the notification itself.",

    slots: [
      {
        id: "zone",
        name: "Zone",
        description: "Zone of the equipment to monitor",
        type: "zone",
        required: true,
      },
      {
        id: "equipment",
        name: "Equipment",
        description: "Equipment to monitor",
        type: "equipment",
        required: true,
      },
      {
        id: "dataKey",
        name: "Data Key",
        description: "Data binding alias to watch (e.g., contact, state)",
        type: "data-key",
        required: true,
      },
      {
        id: "watchValue",
        name: "Watch Value",
        description: "Value that triggers the alarm (e.g., open, true)",
        type: "text",
        required: true,
      },
      {
        id: "delay",
        name: "Delay",
        description: "Time in watched state before first alarm (e.g., 10m)",
        type: "duration",
        required: false,
      },
      {
        id: "checkStart",
        name: "Check Window Start",
        description:
          "Optional. Only alarm while the time is inside this window (start). Leave empty for permanent monitoring.",
        type: "time",
        required: false,
      },
      {
        id: "checkEnd",
        name: "Check Window End",
        description:
          "Optional. End of the check window. The window may cross midnight (e.g. 21:00 to 06:00).",
        type: "time",
        required: false,
      },
    ],

    i18n: {
      fr: {
        name: "Surveillance d'état",
        description:
          "Surveille une donnée d'équipement et déclenche une alarme tant que la valeur reste dans un état donné. Surveillance permanente par défaut, avec délai et créneau horaire optionnels. La re-notification se règle sur la notification.",
        slots: {
          zone: { name: "Zone", description: "Zone de l'équipement à surveiller" },
          equipment: { name: "Équipement", description: "Équipement à surveiller" },
          dataKey: {
            name: "Clé de donnée",
            description: "Alias de la donnée à surveiller (ex: contact, state)",
          },
          watchValue: {
            name: "Valeur surveillée",
            description: "Valeur qui déclenche la surveillance (ex: open, true)",
          },
          delay: {
            name: "Délai",
            description: "Durée avant la première alarme (ex: 10m)",
          },
          checkStart: {
            name: "Début du créneau",
            description:
              "Optionnel. N'alarme que si l'heure est dans ce créneau (début). Vide = surveillance permanente.",
          },
          checkEnd: {
            name: "Fin du créneau",
            description:
              "Optionnel. Fin du créneau de surveillance. Le créneau peut passer minuit (ex: 21:00 à 06:00).",
          },
        },
      },
    },

    // ============================================================
    // Validation
    // ============================================================

    validate(params: Record<string, unknown>, ctx: RecipeContext): void {
      const { zone, equipment, dataKey, watchValue, delay, checkStart, checkEnd } = params;

      // Validate zone
      if (!zone || typeof zone !== "string") {
        throw new Error("Zone parameter is required");
      }
      if (!ctx.zoneManager.getById(zone)) {
        throw new Error(`Zone not found: ${zone}`);
      }

      // Validate equipment
      if (!equipment || typeof equipment !== "string") {
        throw new Error("Equipment parameter is required");
      }
      const eq = ctx.equipmentManager.getByIdWithDetails(equipment);
      if (!eq) {
        throw new Error(`Equipment not found: ${equipment}`);
      }
      if (eq.zoneId !== zone) {
        throw new Error(`Equipment "${eq.name}" does not belong to the selected zone`);
      }

      // Validate dataKey
      if (!dataKey || typeof dataKey !== "string") {
        throw new Error("Data key parameter is required");
      }
      const hasBinding = eq.dataBindings.some((b) => b.alias === dataKey);
      if (!hasBinding) {
        throw new Error(`Equipment "${eq.name}" has no data binding with alias "${dataKey}"`);
      }

      // Validate watchValue
      if (watchValue === undefined || watchValue === null || watchValue === "") {
        throw new Error("Watch value parameter is required");
      }

      // Monitoring is permanent by default — the delay and the check window are
      // optional refinements.
      const hasDelay = delay !== undefined && delay !== null && delay !== "";
      if (hasDelay) ctx.helpers.parseDuration(delay);

      // Check window: start and end must be provided together, both valid HH:MM.
      const hasStart = checkStart !== undefined && checkStart !== null && checkStart !== "";
      const hasEnd = checkEnd !== undefined && checkEnd !== null && checkEnd !== "";
      if (hasStart !== hasEnd) {
        throw new Error("The check window needs both a start and an end time");
      }
      const timeRe = /^\d{1,2}:\d{2}$/;
      if (hasStart && !timeRe.test(String(checkStart))) {
        throw new Error(`Invalid start time: ${String(checkStart)}. Use HH:MM (e.g., "21:00")`);
      }
      if (hasEnd && !timeRe.test(String(checkEnd))) {
        throw new Error(`Invalid end time: ${String(checkEnd)}. Use HH:MM (e.g., "06:00")`);
      }
    },

    // ============================================================
    // Instance creation
    // ============================================================

    createInstance(params: Record<string, unknown>, ctx: RecipeContext) {
      const equipmentId = params.equipment as string;
      const dataKey = params.dataKey as string;
      const watchValue = String(params.watchValue);

      const delayMs =
        params.delay !== undefined && params.delay !== null && params.delay !== ""
          ? ctx.helpers.parseDuration(params.delay)
          : null;

      const checkStartStr =
        params.checkStart !== undefined && params.checkStart !== null && params.checkStart !== ""
          ? String(params.checkStart)
          : null;
      const checkEndStr =
        params.checkEnd !== undefined && params.checkEnd !== null && params.checkEnd !== ""
          ? String(params.checkEnd)
          : null;
      const hasWindow = checkStartStr !== null && checkEndStr !== null;

      // ============================================================
      // Summary (state.summary) — what this instance watches, shown on its
      // recipe row. The binding's category is read once, at start; editing
      // the instance restarts it and so recomputes the label.
      // ============================================================

      function watchedCategory(): string | undefined {
        try {
          const eq = ctx.equipmentManager.getByIdWithDetails(equipmentId);
          return eq?.dataBindings.find((b) => b.alias === dataKey)?.category;
        } catch {
          return undefined;
        }
      }

      const label = watchLabel(dataKey, watchValue, watchedCategory());

      function publishSummary(alarm: boolean): void {
        try {
          const summary = buildSummary({
            label,
            delayMs,
            window: hasWindow ? { start: checkStartStr!, end: checkEndStr! } : null,
            alarm,
          });
          if (ctx.state.get("summary") !== summary) ctx.state.set("summary", summary);
        } catch (err) {
          ctx.logger.error({ err }, "Failed to publish the state-watch summary");
        }
      }

      // Instance state (closure variables)
      const unsubs: (() => void)[] = [];
      let delayTimer: ReturnType<typeof setTimeout> | null = null;
      let windowStartTimer: ReturnType<typeof setTimeout> | null = null;
      let windowEndTimer: ReturnType<typeof setTimeout> | null = null;

      // ============================================================
      // Timer cleanup
      // ============================================================

      function clearDelayTimer(): void {
        if (delayTimer) {
          clearTimeout(delayTimer);
          delayTimer = null;
        }
      }

      function clearWindowTimers(): void {
        if (windowStartTimer) {
          clearTimeout(windowStartTimer);
          windowStartTimer = null;
        }
        if (windowEndTimer) {
          clearTimeout(windowEndTimer);
          windowEndTimer = null;
        }
      }

      // ============================================================
      // Condition: watched state AND (no window OR inside window)
      // ============================================================

      function matchesWatchValue(value: unknown): boolean {
        return String(value) === watchValue;
      }

      function readCurrentValue(): unknown {
        const eq = ctx.equipmentManager.getByIdWithDetails(equipmentId);
        if (!eq) return undefined;
        const binding = eq.dataBindings.find((b) => b.alias === dataKey);
        return binding?.value;
      }

      function inWindow(): boolean {
        if (!hasWindow) return true;
        const now = new Date();
        return isWithinWindow(
          now.getHours() * 60 + now.getMinutes(),
          hmToMinutes(checkStartStr!),
          hmToMinutes(checkEndStr!),
        );
      }

      function shouldAlarm(): boolean {
        return matchesWatchValue(readCurrentValue()) && inWindow();
      }

      // ============================================================
      // Alarm management
      // ============================================================

      // Only ever called from a not-alarmed state (evaluate guards on it).
      function raiseAlarm(): void {
        ctx.state.set("alarm", true);
        ctx.state.set("alarmSince", new Date().toISOString());
        publishSummary(true);
        ctx.log(`ALARM: ${dataKey}=${watchValue}`);
      }

      /** Cancel any pending grace and clear an active alarm. Logs `logMsg` only
       *  when an alarm was actually active. */
      function resetAlarm(logMsg?: string): void {
        clearDelayTimer();
        const wasInAlarm = ctx.state.get("alarm") === true;
        ctx.state.delete("watchStartedAt");
        if (wasInAlarm) {
          ctx.state.set("alarm", false);
          ctx.state.set("alarmSince", null);
          publishSummary(false);
          if (logMsg) ctx.log(logMsg);
        }
      }

      // ============================================================
      // Core reconciliation — run on value change and window edges
      // ============================================================

      function evaluate(): void {
        if (shouldAlarm()) {
          if (ctx.state.get("alarm") === true || delayTimer) return; // already alarmed / pending
          if (delayMs !== null && delayMs > 0) {
            ctx.state.set("watchStartedAt", new Date().toISOString());
            delayTimer = setTimeout(() => {
              delayTimer = null;
              if (shouldAlarm()) raiseAlarm();
            }, delayMs);
            ctx.log(`${dataKey}=${watchValue} — alarm in ${ctx.helpers.formatDuration(delayMs)}`);
          } else {
            raiseAlarm();
          }
        } else {
          // Condition no longer holds (value left the state, or window closed).
          if (ctx.state.get("alarm") === true) {
            resetAlarm(`${dataKey} — alarm cleared`);
          } else if (delayTimer) {
            clearDelayTimer();
            ctx.state.delete("watchStartedAt");
          }
        }
      }

      // ============================================================
      // Check-window boundary timers (re-evaluate at start + end)
      // ============================================================

      function scheduleWindowStart(): void {
        windowStartTimer = setTimeout(() => {
          windowStartTimer = null;
          evaluate();
          scheduleWindowStart();
        }, msUntilNextOccurrence(checkStartStr!));
      }

      function scheduleWindowEnd(): void {
        windowEndTimer = setTimeout(() => {
          windowEndTimer = null;
          evaluate();
          scheduleWindowEnd();
        }, msUntilNextOccurrence(checkEndStr!));
      }

      // ============================================================
      // State restoration (after app restart)
      // ============================================================

      function restoreState(): void {
        ctx.log(`Current: ${dataKey}=${String(readCurrentValue())}`);

        const alarmed = ctx.state.get("alarm") === true;

        if (!shouldAlarm()) {
          if (alarmed) resetAlarm("Alarm cleared on restart — condition no longer met");
          return;
        }

        if (alarmed) {
          ctx.log("Alarm still active after restart");
          return;
        }

        // Condition holds but not yet alarmed — resume a pending grace or start fresh.
        const watchStartedAt = ctx.state.get("watchStartedAt") as string | undefined;
        if (delayMs !== null && delayMs > 0 && watchStartedAt) {
          const remaining = delayMs - (Date.now() - new Date(watchStartedAt).getTime());
          if (remaining <= 0) {
            raiseAlarm();
          } else {
            delayTimer = setTimeout(() => {
              delayTimer = null;
              if (shouldAlarm()) raiseAlarm();
            }, remaining);
          }
        } else {
          evaluate();
        }
      }

      // ============================================================
      // Initialize
      // ============================================================

      // Ensure all state keys exist in DB so they appear in notification publisher dropdowns.
      // Only write defaults for keys not yet set (alarm=false/true distinguishes from null=missing).
      const defaults: Record<string, unknown> = {
        alarm: false,
        alarmSince: null,
      };
      for (const [key, defaultVal] of Object.entries(defaults)) {
        const current = ctx.state.get(key);
        // state.get() returns null both for missing keys and for keys set to null.
        // For "alarm", check specifically — false/true means it was already set.
        if (key === "alarm" && (current === true || current === false)) continue;
        // For others, always write to ensure the row exists in recipe_state table.
        if (key !== "alarm") {
          ctx.state.set(key, current ?? defaultVal);
        } else {
          ctx.state.set(key, defaultVal);
        }
      }

      // Subscribe to equipment data changes
      const unsub = ctx.eventBus.onType("equipment.data.changed", (event) => {
        if (event.equipmentId !== equipmentId) return;
        if (event.alias !== dataKey) return;
        try {
          evaluate();
        } catch (err) {
          ctx.logger.error({ err, equipmentId, dataKey }, "State-watch evaluation failed");
        }
      });
      unsubs.push(unsub);

      // Schedule check-window edge timers if a window is configured
      if (hasWindow) {
        scheduleWindowStart();
        scheduleWindowEnd();
      }

      // Restore state from persistence
      restoreState();

      // After the restore, which may have raised or cleared the alarm.
      publishSummary(ctx.state.get("alarm") === true);

      // ============================================================
      // Return instance handle
      // ============================================================

      return {
        stop() {
          clearDelayTimer();
          clearWindowTimers();
          for (const fn of unsubs) {
            fn();
          }

          // Clear persisted state
          ctx.state.delete("alarm");
          ctx.state.delete("alarmSince");
          ctx.state.delete("watchStartedAt");
          // The summary names the instance, so it stays — without the alarm.
          publishSummary(false);
        },
      };
    },
  };
}
