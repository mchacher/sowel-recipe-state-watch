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
      dataBindings: Array<{ alias: string; value?: unknown }>;
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

// ============================================================
// Recipe Definition
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "state-watch",
    name: "State Watch",
    description:
      "Monitor an equipment data key and raise an alarm when the value stays in a watched state. Supports delayed alarm, periodic repeat, and daily scheduled check.",

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
        id: "repeatInterval",
        name: "Repeat Interval",
        description: "Re-alarm interval while still in watched state (e.g., 1h)",
        type: "duration",
        required: false,
      },
      {
        id: "checkTime",
        name: "Check Time",
        description: "Daily check time — alarm if still in watched state (e.g., 23:00)",
        type: "time",
        required: false,
      },
    ],

    i18n: {
      fr: {
        name: "Surveillance d'état",
        description:
          "Surveille une donnée d'équipement et déclenche une alarme si la valeur reste dans un état donné. Supporte un délai, une répétition périodique et un check quotidien à heure fixe.",
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
          repeatInterval: {
            name: "Intervalle de répétition",
            description: "Intervalle de rappel tant que l'état persiste (ex: 1h)",
          },
          checkTime: {
            name: "Heure de vérification",
            description: "Heure de check quotidien — alarme si encore dans l'état (ex: 23:00)",
          },
        },
      },
    },

    // ============================================================
    // Validation
    // ============================================================

    validate(params: Record<string, unknown>, ctx: RecipeContext): void {
      const { zone, equipment, dataKey, watchValue, delay, repeatInterval, checkTime } = params;

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

      // Validate at least one trigger mode
      const hasDelay = delay !== undefined && delay !== null && delay !== "";
      const hasRepeat =
        repeatInterval !== undefined && repeatInterval !== null && repeatInterval !== "";
      const hasCheck = checkTime !== undefined && checkTime !== null && checkTime !== "";

      if (!hasDelay && !hasRepeat && !hasCheck) {
        throw new Error(
          "At least one trigger mode is required: delay, repeatInterval, or checkTime",
        );
      }

      // Validate duration formats
      if (hasDelay) ctx.helpers.parseDuration(delay);
      if (hasRepeat) ctx.helpers.parseDuration(repeatInterval);

      // Validate time format
      if (hasCheck) {
        const timeStr = String(checkTime);
        if (!/^\d{1,2}:\d{2}$/.test(timeStr)) {
          throw new Error(`Invalid time format: ${timeStr}. Use HH:MM (e.g., "23:00")`);
        }
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

      const repeatIntervalMs =
        params.repeatInterval !== undefined &&
        params.repeatInterval !== null &&
        params.repeatInterval !== ""
          ? ctx.helpers.parseDuration(params.repeatInterval)
          : null;

      const checkTimeStr =
        params.checkTime !== undefined && params.checkTime !== null && params.checkTime !== ""
          ? String(params.checkTime)
          : null;

      // Instance state (closure variables)
      const unsubs: (() => void)[] = [];
      let delayTimer: ReturnType<typeof setTimeout> | null = null;
      let repeatTimer: ReturnType<typeof setTimeout> | null = null;
      let checkTimer: ReturnType<typeof setTimeout> | null = null;

      // ============================================================
      // Timer cleanup
      // ============================================================

      function clearDelayTimer(): void {
        if (delayTimer) {
          clearTimeout(delayTimer);
          delayTimer = null;
        }
      }

      function clearRepeatTimer(): void {
        if (repeatTimer) {
          clearTimeout(repeatTimer);
          repeatTimer = null;
        }
      }

      function clearCheckTimer(): void {
        if (checkTimer) {
          clearTimeout(checkTimer);
          checkTimer = null;
        }
      }

      // ============================================================
      // Value comparison
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

      // ============================================================
      // Alarm management
      // ============================================================

      function raiseAlarm(): void {
        const wasInAlarm = ctx.state.get("alarm") === true;
        const alarmCount = ((ctx.state.get("alarmCount") as number) ?? 0) + 1;

        if (!wasInAlarm) {
          ctx.state.set("alarm", true);
          ctx.state.set("alarmSince", new Date().toISOString());
        }
        ctx.state.set("alarmCount", alarmCount);

        if (!wasInAlarm) {
          ctx.log(`ALARM: ${dataKey}=${watchValue}`);
        } else {
          ctx.log(`ALARM repeat #${alarmCount}`);
        }

        // Start repeat timer if configured
        if (repeatIntervalMs) {
          startRepeatTimer();
        }
      }

      function startRepeatTimer(): void {
        clearRepeatTimer();
        repeatTimer = setTimeout(() => {
          repeatTimer = null;
          // Only repeat if still in watched state
          const currentValue = readCurrentValue();
          if (matchesWatchValue(currentValue)) {
            raiseAlarm();
          }
        }, repeatIntervalMs!);
      }

      // ============================================================
      // Scheduled check (checkTime)
      // ============================================================

      function scheduleNextCheck(): void {
        clearCheckTimer();
        const ms = msUntilNextOccurrence(checkTimeStr!);
        checkTimer = setTimeout(() => {
          checkTimer = null;
          onScheduledCheck();
          // Reschedule for next day
          scheduleNextCheck();
        }, ms);
      }

      function onScheduledCheck(): void {
        const currentValue = readCurrentValue();
        ctx.state.set("currentValue", currentValue);

        if (!matchesWatchValue(currentValue)) return;

        const wasInAlarm = ctx.state.get("alarm") === true;
        const alarmCount = ((ctx.state.get("alarmCount") as number) ?? 0) + 1;

        if (!wasInAlarm) {
          ctx.state.set("alarm", true);
          ctx.state.set("alarmSince", new Date().toISOString());
        }
        ctx.state.set("alarmCount", alarmCount);
        ctx.log(
          `Check ${checkTimeStr}: ${dataKey}=${watchValue} — ALARM #${alarmCount}`,
        );
      }

      // ============================================================
      // Event handlers
      // ============================================================

      function onValueEntersWatchedState(): void {
        const now = new Date().toISOString();
        ctx.state.set("watchStartedAt", now);

        if (delayMs !== null && delayMs > 0) {
          delayTimer = setTimeout(() => {
            delayTimer = null;
            raiseAlarm();
          }, delayMs);
          ctx.log(`${dataKey}=${watchValue} — alarm in ${ctx.helpers.formatDuration(delayMs)}`);
        } else if (delayMs === 0 || (delayMs === null && repeatIntervalMs !== null)) {
          raiseAlarm();
        } else if (checkTimeStr) {
          ctx.log(`${dataKey}=${watchValue} — check at ${checkTimeStr}`);
        }
      }

      function onValueLeavesWatchedState(newValue: unknown): void {
        clearDelayTimer();
        clearRepeatTimer();

        const wasInAlarm = ctx.state.get("alarm") === true;
        ctx.state.delete("watchStartedAt");

        if (wasInAlarm) {
          ctx.state.set("alarm", false);
          ctx.state.set("alarmSince", null);
          ctx.state.set("alarmCount", 0);
          ctx.log(`${dataKey}=${String(newValue)} — alarm cleared`);
        } else {
          ctx.log(`${dataKey}=${String(newValue)}`);
        }
      }

      function onValueChanged(value: unknown): void {
        const previousValue = ctx.state.get("currentValue");
        ctx.state.set("currentValue", value);

        // Skip processing if value hasn't actually changed
        if (String(value) === String(previousValue)) return;

        if (matchesWatchValue(value)) {
          if (!ctx.state.get("watchStartedAt")) {
            onValueEntersWatchedState();
          }
        } else {
          onValueLeavesWatchedState(value);
        }
      }

      // ============================================================
      // State restoration (after app restart)
      // ============================================================

      function restoreState(): void {
        const currentValue = readCurrentValue();
        ctx.state.set("currentValue", currentValue);

        const isInWatchedState = matchesWatchValue(currentValue);
        const wasInAlarm = ctx.state.get("alarm") === true;
        const watchStartedAt = ctx.state.get("watchStartedAt") as string | undefined;

        ctx.log(`Current: ${dataKey}=${String(currentValue)}`);

        if (!isInWatchedState) {
          if (wasInAlarm) {
            ctx.state.set("alarm", false);
            ctx.state.set("alarmSince", null);
            ctx.state.set("alarmCount", 0);
            ctx.state.delete("watchStartedAt");
            ctx.log("Alarm cleared on restart");
          }
          return;
        }

        if (wasInAlarm) {
          if (repeatIntervalMs) {
            startRepeatTimer();
          }
          ctx.log("Alarm still active after restart");
        } else if (watchStartedAt && delayMs !== null) {
          // Was waiting for delay — recalculate
          const elapsed = Date.now() - new Date(watchStartedAt).getTime();
          const remaining = delayMs - elapsed;
          if (remaining <= 0) {
            // Delay already expired during downtime
            raiseAlarm();
          } else {
            delayTimer = setTimeout(() => {
              delayTimer = null;
              raiseAlarm();
            }, remaining);
          }
        } else if (!watchStartedAt) {
          // No watchStartedAt but value is in watched state — treat as fresh entry
          onValueEntersWatchedState();
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
        alarmCount: 0,
        currentValue: null,
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
        onValueChanged(event.value);
      });
      unsubs.push(unsub);

      // Start daily check timer if configured
      if (checkTimeStr) {
        scheduleNextCheck();
      }

      // Restore state from persistence
      restoreState();

      // ============================================================
      // Return instance handle
      // ============================================================

      return {
        stop() {
          clearDelayTimer();
          clearRepeatTimer();
          clearCheckTimer();
          for (const fn of unsubs) {
            fn();
          }

          // Clear persisted state
          ctx.state.delete("alarm");
          ctx.state.delete("alarmSince");
          ctx.state.delete("alarmCount");
          ctx.state.delete("currentValue");
          ctx.state.delete("watchStartedAt");
        },
      };
    },
  };
}
