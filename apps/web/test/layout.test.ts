// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function freshStore() {
  vi.resetModules();
  return (await import('../src/stores/layout')).useLayout;
}

beforeEach(() => localStorage.clear());

describe('assistant dock', () => {
  it('opens as an overlay over the code by default', async () => {
    const layout = await freshStore();
    layout.getState().toggleAssistant();
    expect(layout.getState()).toMatchObject({ assistant: true, assistantDock: 'overlay', assistantCollapsed: false });
    layout.getState().toggleAssistant();
    expect(layout.getState().assistant).toBe(false);
  });

  it('brings a collapsed overlay or a background tab into view before closing it', async () => {
    const layout = await freshStore();
    layout.getState().showAssistant();
    layout.getState().setAssistantCollapsed(true);
    layout.getState().toggleAssistant();
    expect(layout.getState()).toMatchObject({ assistant: true, assistantCollapsed: false });

    layout.getState().setAssistantDock('tab');
    layout.getState().setAssistantFront(false);
    layout.getState().toggleAssistant();
    expect(layout.getState()).toMatchObject({ assistant: true, assistantFront: true });
    layout.getState().toggleAssistant();
    expect(layout.getState().assistant).toBe(false);
  });

  it('switching docks puts the assistant in front', async () => {
    const layout = await freshStore();
    layout.getState().showAssistant();
    layout.getState().setAssistantCollapsed(true);
    layout.getState().setAssistantDock('tab');
    expect(layout.getState()).toMatchObject({ assistantDock: 'tab', assistantFront: true, assistantCollapsed: false });
  });

  it('remembers the dock and height, and ignores corrupt values', async () => {
    let layout = await freshStore();
    layout.getState().showAssistant();
    layout.getState().setAssistantDock('tab');
    layout.getState().setAssistantShare(0.05);
    layout = await freshStore();
    expect(layout.getState()).toMatchObject({ assistant: true, assistantDock: 'tab', assistantShare: 0.2 });

    localStorage.setItem('rs.layout', JSON.stringify({ assistant: 'yes', assistantDock: 'floating', assistantShare: 'tall', explorer: false }));
    layout = await freshStore();
    expect(layout.getState()).toMatchObject({ assistant: false, assistantDock: 'overlay', assistantShare: 0.5, explorer: false });
  });

  it('keeps reading layouts saved before the dock existed', async () => {
    localStorage.setItem('rs.layout', JSON.stringify({ explorer: true, diagnostics: false, assistant: true, references: true, evidence: false }));
    const layout = await freshStore();
    expect(layout.getState()).toMatchObject({ diagnostics: false, assistant: true, references: true, assistantDock: 'overlay' });
  });
});
