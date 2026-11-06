// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorScreen } from '../src/ErrorScreen';

function Broken(): never {
  throw new Error('Cannot read properties of undefined (reading "label")');
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('ErrorScreen', () => {
  it('shows a render error instead of an empty page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorScreen>
        <Broken />
      </ErrorScreen>,
    );
    expect(screen.getByRole('heading', { name: 'This page stopped working' })).toBeTruthy();
    expect(screen.getByText(/reading "label"/)).toBeTruthy();
  });

  it('resets saved view settings but keeps the runtime connection', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload });
    for (const [k, v] of Object.entries({ 'rs.layout': '{}', 'rs.ai.target': 'model:x', 'rs.visual.settings': '{}', 'rs.pairingToken': 'tok', 'rs.runtimeUrl': 'http://127.0.0.1:4317' })) localStorage.setItem(k, v);
    render(
      <ErrorScreen>
        <Broken />
      </ErrorScreen>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset view settings and reload' }));
    expect(reload).toHaveBeenCalled();
    expect(Object.keys(localStorage).sort()).toEqual(['rs.pairingToken', 'rs.runtimeUrl']);
  });

  it('renders its children when nothing fails', () => {
    render(
      <ErrorScreen>
        <p>Workspace</p>
      </ErrorScreen>,
    );
    expect(screen.getByText('Workspace')).toBeTruthy();
  });
});
