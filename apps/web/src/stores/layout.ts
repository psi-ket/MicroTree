import { create } from 'zustand';
import { KEYS, local } from '../lib/storage';

export type BottomTab = 'problems' | 'log';

/** Where the assistant sits in the editor pane: docked over the bottom of the code, or as a tab beside the files. */
export type AssistantDock = 'overlay' | 'tab';

/** Overlay height as a share of the editor pane, so it suits any window size. */
export const ASSISTANT_SHARE = { min: 0.2, max: 0.9, default: 0.5 } as const;
const clampShare = (share: number) => Math.min(ASSISTANT_SHARE.max, Math.max(ASSISTANT_SHARE.min, share));

interface LayoutState {
  explorer: boolean;
  diagnostics: boolean;
  assistant: boolean;
  references: boolean;
  evidence: boolean;
  assistantDock: AssistantDock;
  /** Tab dock only: the assistant tab, not the active file, fills the editor pane. */
  assistantFront: boolean;
  /** Overlay dock only: just the header bar is shown. */
  assistantCollapsed: boolean;
  /** Overlay dock only: share of the editor pane's height. */
  assistantShare: number;
  /** Overlay dock only: the height it actually has on screen, in pixels (not saved). */
  assistantOverlayPx: number;
  bottomTab: BottomTab;
  palette: 'files' | 'commands' | null;
  settingsOpen: boolean;
  toggle(panel: 'explorer' | 'diagnostics' | 'assistant' | 'references' | 'evidence', value?: boolean): void;
  /** Open the assistant and bring it into view, whichever dock it uses. */
  showAssistant(): void;
  /** Top-bar button: show the assistant, or close it when it is already in view. */
  toggleAssistant(): void;
  setAssistantDock(dock: AssistantDock): void;
  setAssistantFront(front: boolean): void;
  setAssistantCollapsed(collapsed: boolean): void;
  setAssistantShare(share: number): void;
  setAssistantOverlayPx(px: number): void;
  setBottomTab(tab: BottomTab): void;
  openPalette(mode: 'files' | 'commands' | null): void;
  setSettingsOpen(open: boolean): void;
}

const PERSISTED = ['explorer', 'diagnostics', 'assistant', 'references', 'evidence', 'assistantDock', 'assistantFront', 'assistantCollapsed', 'assistantShare'] as const;
type Persisted = Pick<LayoutState, (typeof PERSISTED)[number]>;

const DEFAULTS: Persisted = {
  explorer: true,
  diagnostics: true,
  assistant: false,
  references: false,
  evidence: false,
  assistantDock: 'overlay',
  assistantFront: true,
  assistantCollapsed: false,
  assistantShare: ASSISTANT_SHARE.default,
};

function load(): Persisted {
  try {
    const raw = local.get(KEYS.layout);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Record<keyof Persisted, unknown>>;
      const flag = (k: keyof Persisted) => (typeof v[k] === 'boolean' ? (v[k] as boolean) : (DEFAULTS[k] as boolean));
      return {
        explorer: flag('explorer'),
        diagnostics: flag('diagnostics'),
        assistant: flag('assistant'),
        references: flag('references'),
        evidence: flag('evidence'),
        assistantDock: v.assistantDock === 'tab' ? 'tab' : 'overlay',
        assistantFront: flag('assistantFront'),
        assistantCollapsed: flag('assistantCollapsed'),
        assistantShare: typeof v.assistantShare === 'number' && Number.isFinite(v.assistantShare) ? clampShare(v.assistantShare) : ASSISTANT_SHARE.default,
      };
    }
  } catch {
    /* corrupt value: fall back to defaults */
  }
  return { ...DEFAULTS };
}

export const useLayout = create<LayoutState>((set, get) => {
  const update = (patch: Partial<LayoutState>) => {
    set(patch);
    const state = get();
    local.set(KEYS.layout, JSON.stringify(Object.fromEntries(PERSISTED.map((k) => [k, state[k]]))));
  };
  const inView = () => {
    const s = get();
    return s.assistant && (s.assistantDock === 'tab' ? s.assistantFront : !s.assistantCollapsed);
  };
  return {
    ...load(),
    assistantOverlayPx: 0,
    bottomTab: 'problems',
    palette: null,
    settingsOpen: false,
    toggle: (panel, value) => {
      const next = value ?? !get()[panel];
      if (panel === 'assistant' && next) return update({ assistant: true, assistantFront: true, assistantCollapsed: false });
      update({ [panel]: next } as Partial<LayoutState>);
    },
    showAssistant: () => update({ assistant: true, assistantFront: true, assistantCollapsed: false }),
    toggleAssistant: () => (inView() ? update({ assistant: false }) : get().showAssistant()),
    setAssistantDock: (assistantDock) => update({ assistantDock, assistantFront: true, assistantCollapsed: false }),
    setAssistantFront: (assistantFront) => {
      if (get().assistantFront !== assistantFront) update({ assistantFront });
    },
    setAssistantCollapsed: (assistantCollapsed) => update({ assistantCollapsed }),
    setAssistantShare: (share) => update({ assistantShare: Math.round(clampShare(share) * 1000) / 1000 }),
    setAssistantOverlayPx: (assistantOverlayPx) => {
      if (get().assistantOverlayPx !== assistantOverlayPx) set({ assistantOverlayPx });
    },
    setBottomTab: (bottomTab) => set({ bottomTab }),
    openPalette: (palette) => set({ palette }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  };
});
