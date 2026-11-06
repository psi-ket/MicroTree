// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';

const ai = {
  status: vi.fn(),
  listProviders: vi.fn(),
  listAgents: vi.fn(),
  agentApprovals: vi.fn(),
  createProvider: vi.fn(),
};

vi.mock('../src/lib/connection', () => ({
  runtime: () => ({ ai }),
  useConnection: Object.assign((select: (s: { status: string }) => unknown) => select({ status: 'connected' }), { getState: () => ({ status: 'connected' }) }),
}));

const { queryClient } = await import('../src/lib/queries');
const { SetupDialog } = await import('../src/features/assistant/SetupDialog');
const { useAssistant } = await import('../src/features/assistant/state');

beforeEach(() => {
  ai.status.mockResolvedValue({ secretStore: { kind: 'keyring', notice: null }, agentsEnabled: true, limits: { maxOutputTokens: 4096, requestTimeoutMs: 180_000, agentTimeoutMs: 900_000 } });
  ai.listProviders.mockResolvedValue({ providers: [] });
  ai.listAgents.mockResolvedValue({ agents: [] });
  ai.agentApprovals.mockResolvedValue({ approvals: [] });
  ai.createProvider.mockImplementation((body: { kind: string; displayName: string }) => Promise.resolve({ provider: { id: `${body.kind}-1`, kind: body.kind, displayName: body.displayName, defaultModel: 'default' } }));
  useAssistant.setState({ setupOpen: true });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.clearAllMocks();
});

const renderDialog = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <SetupDialog projectId="p1" />
    </QueryClientProvider>,
  );

describe('adding a model provider', () => {
  it('offers Claude Code and Codex with no URL or key, and says where requests go', async () => {
    renderDialog();
    const service = await screen.findByLabelText('Service');
    expect(screen.getByLabelText('Base URL')).toBeTruthy();
    expect(screen.getByLabelText('API key')).toBeTruthy();

    fireEvent.change(service, { target: { value: 'claude-cli' } });
    expect(screen.queryByLabelText('Base URL')).toBeNull();
    expect(screen.queryByLabelText('API key')).toBeNull();
    expect(screen.getByText(/Runs Claude Code on this computer with your own sign-in, every tool off\. What you send goes to Anthropic\./)).toBeTruthy();
    expect((await axe.run(document.body)).violations).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(ai.createProvider).toHaveBeenCalledWith({ kind: 'claude-cli', displayName: 'Claude Code (your sign-in)', baseUrl: null, defaultModel: null, apiKey: null }));
    expect(useAssistant.getState().target).toBe('model:claude-cli-1');

    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'codex-cli' } });
    expect(screen.getByText(/What you send goes to OpenAI\./)).toBeTruthy();
  });

  it('never sends a URL or key typed for another service to a CLI provider', async () => {
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Service'), { target: { value: 'openai' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://llm.example.org/v1' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-typed-for-openai-0123456789' } });
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'codex-cli' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(ai.createProvider).toHaveBeenCalledWith(expect.objectContaining({ kind: 'codex-cli', baseUrl: null, apiKey: null })));
  });
});
