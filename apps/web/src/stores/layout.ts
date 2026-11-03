import { create } from 'zustand';
import { KEYS, local } from '../lib/storage';

export type BottomTab = 'problems' | 'log';

interface LayoutState {
  explorer: boolean;
  diagnostics: boolean;
  assistant: boolean;
  references: boolean;
  bottomTab: BottomTab;
  palette: 'files' | 'commands' | null;
  settingsOpen: boolean;
  toggle(panel: 'explorer' | 'diagnostics' | 'assistant' | 'references', value?: boolean): void;
  setBottomTab(tab: BottomTab): void;
  openPalette(mode: 'files' | 'commands' | null): void;
  setSettingsOpen(open: boolean): void;
}

type Persisted = Pick<LayoutState, 'explorer' | 'diagnostics' | 'assistant' | 'references'>;

function load(): Persisted {
  try {
    const raw = local.get(KEYS.layout);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Persisted>;
      return { explorer: v.explorer ?? true, diagnostics: v.diagnostics ?? true, assistant: v.assistant ?? false, references: v.references ?? false };
    }
  } catch {
    /* corrupt value: fall back to defaults */
  }
  return { explorer: true, diagnostics: true, assistant: false, references: false };
}

export const useLayout = create<LayoutState>((set, get) => ({
  ...load(),
  bottomTab: 'problems',
  palette: null,
  settingsOpen: false,
  toggle: (panel, value) => {
    set({ [panel]: value ?? !get()[panel] } as Partial<LayoutState>);
    const { explorer, diagnostics, assistant, references } = get();
    local.set(KEYS.layout, JSON.stringify({ explorer, diagnostics, assistant, references }));
  },
  setBottomTab: (bottomTab) => set({ bottomTab }),
  openPalette: (palette) => set({ palette }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}));
