import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_SETTINGS,
  STAGES,
  type ActivityEvent,
  type JobRecord,
  type JobStatus,
  type MediaItem,
  type ScheduledJob,
  type Settings,
  type StageId,
} from "./types";

interface AppState {
  settings: Settings;
  patchSettings: (p: Partial<Settings>) => void;
  urlsText: string;
  setUrlsText: (v: string) => void;
  stage: StageId;
  jobStatus: JobStatus;
  items: MediaItem[];
  events: ActivityEvent[];
  startedAt: number | null;
  previewLabel: string | null;
  monitorOpen: boolean;
  settingsOpen: boolean;
  cookiesOpen: boolean;
  distroOpen: boolean;
  companionOpen: boolean;
  schedulerOpen: boolean;
  schedules: ScheduledJob[];
  history: JobRecord[];
  setMonitorOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setCookiesOpen: (v: boolean) => void;
  setDistroOpen: (v: boolean) => void;
  setCompanionOpen: (v: boolean) => void;
  setSchedulerOpen: (v: boolean) => void;
  resetJob: () => void;
  setJobStatus: (s: JobStatus) => void;
  setStage: (s: StageId) => void;
  setPreviewLabel: (s: string | null) => void;
  addEvent: (e: Omit<ActivityEvent, "id" | "at"> & { at?: number }) => void;
  setItems: (items: MediaItem[]) => void;
  updateItem: (id: string, patch: Partial<MediaItem>) => void;
  toggleSelect: (id: string) => void;
  selectAll: (v: boolean) => void;
  setStartedAt: (n: number | null) => void;
  upsertSchedule: (job: ScheduledJob) => void;
  removeSchedule: (id: string) => void;
  pushHistory: (r: JobRecord) => void;
}

let eventSeq = 0;

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      patchSettings: (p) => set({ settings: { ...get().settings, ...p } }),
      urlsText: "",
      setUrlsText: (v) => set({ urlsText: v }),
      stage: "crawl",
      jobStatus: "idle",
      items: [],
      events: [],
      startedAt: null,
      previewLabel: null,
      monitorOpen: true,
      settingsOpen: false,
      cookiesOpen: false,
      distroOpen: false,
      companionOpen: false,
      schedulerOpen: false,
      schedules: [],
      history: [],
      setMonitorOpen: (v) => set({ monitorOpen: v }),
      setSettingsOpen: (v) => set({ settingsOpen: v }),
      setCookiesOpen: (v) => set({ cookiesOpen: v }),
      setDistroOpen: (v) => set({ distroOpen: v }),
      setCompanionOpen: (v) => set({ companionOpen: v }),
      setSchedulerOpen: (v) => set({ schedulerOpen: v }),
      resetJob: () =>
        set({
          stage: "crawl",
          jobStatus: "idle",
          items: [],
          events: [],
          startedAt: null,
          previewLabel: null,
        }),
      setJobStatus: (s) => set({ jobStatus: s }),
      setStage: (s) => set({ stage: s }),
      setPreviewLabel: (s) => set({ previewLabel: s }),
      addEvent: (e) =>
        set({
          events: [
            ...get().events.slice(-200),
            {
              id: `e${Date.now()}-${eventSeq++}`,
              at: e.at ?? Date.now(),
              level: e.level,
              stage: e.stage,
              message: e.message,
            },
          ],
        }),
      setItems: (items) => set({ items }),
      updateItem: (id, patch) =>
        set({
          items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
        }),
      toggleSelect: (id) =>
        set({
          items: get().items.map((it) => (it.id === id ? { ...it, selected: !it.selected } : it)),
        }),
      selectAll: (v) => set({ items: get().items.map((it) => ({ ...it, selected: v })) }),
      setStartedAt: (n) => set({ startedAt: n }),
      upsertSchedule: (job) =>
        set({
          schedules: (() => {
            const rest = get().schedules.filter((s) => s.id !== job.id);
            return [...rest, job];
          })(),
        }),
      removeSchedule: (id) => set({ schedules: get().schedules.filter((s) => s.id !== id) }),
      pushHistory: (r) => set({ history: [r, ...get().history].slice(0, 12) }),
    }),
    {
      name: "fathomrail-v1",
      partialize: (s) => ({
        settings: s.settings,
        urlsText: s.urlsText,
        schedules: s.schedules,
        history: s.history,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        return {
          ...current,
          ...p,
          settings: { ...DEFAULT_SETTINGS, ...p.settings },
          schedules: p.schedules ?? [],
          history: p.history ?? [],
        };
      },
    },
  ),
);

export function stageIndex(stage: StageId): number {
  return STAGES.indexOf(stage);
}

export function applyTheme(theme: Settings["theme"]) {
  if (typeof document === "undefined") return;
  const light =
    theme === "light" || (theme === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", light ? "#f3f1ea" : "#0b0b0c");
}
