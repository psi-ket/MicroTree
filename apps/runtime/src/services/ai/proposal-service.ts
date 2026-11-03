import { applyRange, type ProposalDraft } from '@research-studio/ai-core';
import type { AiRepositories, NewProposal } from '@research-studio/ai-storage';
import { isStudioError, StudioError, type EditProposal, type ProposalStatus, type WritingActionId } from '@research-studio/shared-types';
import type { EventBus } from '../../events';
import { randomId } from '../../security/tokens';
import type { AuditService } from '../audit-service';
import type { Actor, ProjectService } from '../project-service';

export interface ProposalOrigin {
  conversationId: string | null;
  messageId: string | null;
  agentRunId: string | null;
  source: 'model' | 'agent';
  action: WritingActionId | null;
}

/**
 * Edit proposals: created from validated model output or an agent's staged
 * changes, applied only on an explicit accept, and only while the file still
 * has the content the proposal was made against.
 */
export class ProposalService {
  private readonly unsubscribe: () => void;

  constructor(
    private readonly repos: AiRepositories,
    private readonly projects: ProjectService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {
    // Any write to a file (editor save, upload, another proposal) invalidates
    // pending proposals made against its previous content.
    this.unsubscribe = events.subscribe((event) => {
      if (event.type === 'files.changed') void this.sweep(event.projectId, event.paths);
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** Read a project text file, or null when it is missing or not text. */
  async current(projectId: string, file: string): Promise<{ content: string; hash: string } | null> {
    try {
      const { content, hash } = await this.projects.readFile(projectId, file);
      return { content, hash };
    } catch (err) {
      if (isStudioError(err) && (err.code === 'NOT_FOUND' || err.code === 'UNSUPPORTED_MEDIA_TYPE')) return null;
      throw err;
    }
  }

  create(projectId: string, origin: ProposalOrigin, draft: ProposalDraft, blockIndex: number | null): EditProposal {
    const input: NewProposal = { id: randomId(8), projectId, ...origin, ...draft, blockIndex };
    const proposal = this.repos.proposals.create(input);
    this.publish(proposal);
    return proposal;
  }

  list(projectId: string, status?: ProposalStatus): EditProposal[] {
    this.projects.get(projectId);
    return this.repos.proposals.list(projectId, status ? { status } : {});
  }

  get(projectId: string, id: string): EditProposal {
    const proposal = this.repos.proposals.get(projectId, id);
    if (!proposal) throw new StudioError('NOT_FOUND', 'Proposal not found');
    return proposal;
  }

  async preview(projectId: string, id: string): Promise<{ proposal: EditProposal; before: string | null; after: string | null; stale: boolean }> {
    const proposal = this.get(projectId, id);
    const file = await this.current(projectId, proposal.file);
    if (proposal.status === 'accepted' || proposal.status === 'reverted') {
      return { proposal, before: file?.content ?? null, after: null, stale: false };
    }
    if (!this.matchesBase(proposal, file)) return { proposal, before: file?.content ?? null, after: null, stale: true };
    return { proposal, before: file?.content ?? '', after: this.result(proposal, file?.content ?? ''), stale: false };
  }

  /**
   * Apply a pending proposal. `manualContent` is the whole file after the
   * user edited the proposal in the review view.
   */
  async accept(projectId: string, id: string, manualContent: string | undefined, actor: Actor): Promise<EditProposal> {
    const proposal = this.get(projectId, id);
    if (proposal.status === 'stale') throw new StudioError('STALE_PROPOSAL', `${proposal.file} changed after this edit was proposed. Ask again for a fresh edit.`);
    if (proposal.status !== 'pending') throw new StudioError('CONFLICT', `This proposal is already ${proposal.status}.`);
    const file = await this.current(projectId, proposal.file);
    if (!this.matchesBase(proposal, file)) {
      this.markStale(projectId, proposal);
      throw new StudioError('STALE_PROPOSAL', `${proposal.file} changed after this edit was proposed. Ask again for a fresh edit.`);
    }
    if (manualContent !== undefined && proposal.changeType === 'delete') {
      throw new StudioError('BAD_REQUEST', 'A file deletion cannot be edited; reject it instead.');
    }
    const next = manualContent ?? this.result(proposal, file?.content ?? '');

    // Claim the proposal first so a concurrent accept cannot apply it twice and
    // the stale sweep triggered by our own write does not touch it.
    const claimed = this.repos.proposals.transition(projectId, id, 'pending', 'accepted', { previousContent: file?.content ?? null });
    if (!claimed) throw new StudioError('CONFLICT', 'This proposal was resolved by another request.');
    let appliedHash: string | null = null;
    try {
      if (proposal.changeType === 'delete') {
        await this.projects.deleteEntry(projectId, proposal.file, actor);
      } else {
        const written = await this.projects.writeFile(
          projectId,
          proposal.changeType === 'create'
            ? { path: proposal.file, content: next, createOnly: true }
            : { path: proposal.file, content: next, baseHash: proposal.baseHash },
          actor,
        );
        appliedHash = written.hash;
      }
    } catch (err) {
      const conflict = isStudioError(err) && (err.code === 'CONFLICT' || err.code === 'ALREADY_EXISTS');
      const back = this.repos.proposals.transition(projectId, id, 'accepted', conflict ? 'stale' : 'pending', { previousContent: null });
      if (back) this.publish(back);
      this.audit.record({ action: 'ai.edit.accept', outcome: 'error', actor: actor.sessionId, projectId, target: proposal.file, details: { proposalId: id } });
      if (conflict) throw new StudioError('STALE_PROPOSAL', `${proposal.file} changed while the edit was being applied.`);
      throw err;
    }
    const accepted = this.repos.proposals.setApplied(projectId, id, appliedHash) ?? claimed;
    this.audit.record({
      action: 'ai.edit.accept',
      outcome: 'success',
      actor: actor.sessionId,
      projectId,
      target: proposal.file,
      details: { proposalId: id, source: proposal.source, changeType: proposal.changeType, manual: manualContent !== undefined },
    });
    this.publish(accepted);
    return accepted;
  }

  reject(projectId: string, id: string, actor: Actor): EditProposal {
    const proposal = this.get(projectId, id);
    if (proposal.status !== 'pending' && proposal.status !== 'stale') {
      throw new StudioError('CONFLICT', `This proposal is already ${proposal.status}.`);
    }
    const rejected = this.repos.proposals.transition(projectId, id, proposal.status, 'rejected');
    if (!rejected) throw new StudioError('CONFLICT', 'This proposal was resolved by another request.');
    this.audit.record({ action: 'ai.edit.reject', outcome: 'success', actor: actor.sessionId, projectId, target: proposal.file, details: { proposalId: id } });
    this.publish(rejected);
    return rejected;
  }

  /** Undo an accepted proposal, provided the file still has the content it produced. */
  async revert(projectId: string, id: string, actor: Actor): Promise<EditProposal> {
    const proposal = this.get(projectId, id);
    if (proposal.status !== 'accepted') throw new StudioError('CONFLICT', 'Only accepted proposals can be reverted.');
    const file = await this.current(projectId, proposal.file);
    const previous = this.repos.proposals.previousContent(projectId, id);
    const unchanged = proposal.changeType === 'delete' ? file === null : file !== null && file.hash === proposal.appliedHash;
    if (!unchanged) {
      throw new StudioError('CONFLICT', `${proposal.file} was changed after the edit was applied, so it cannot be reverted automatically.`);
    }
    const reverted = this.repos.proposals.transition(projectId, id, 'accepted', 'reverted');
    if (!reverted) throw new StudioError('CONFLICT', 'This proposal was changed by another request.');
    try {
      if (proposal.changeType === 'create') await this.projects.deleteEntry(projectId, proposal.file, actor);
      else if (proposal.changeType === 'delete') await this.projects.writeFile(projectId, { path: proposal.file, content: previous ?? '', createOnly: true }, actor);
      else await this.projects.writeFile(projectId, { path: proposal.file, content: previous ?? '', baseHash: proposal.appliedHash }, actor);
    } catch (err) {
      this.repos.proposals.transition(projectId, id, 'reverted', 'accepted');
      throw err;
    }
    this.audit.record({ action: 'ai.edit.revert', outcome: 'success', actor: actor.sessionId, projectId, target: proposal.file, details: { proposalId: id } });
    this.publish(reverted);
    return reverted;
  }

  private matchesBase(proposal: EditProposal, file: { hash: string } | null): boolean {
    if (proposal.changeType === 'create') return file === null;
    return file !== null && file.hash === proposal.baseHash;
  }

  private result(proposal: EditProposal, content: string): string {
    if (proposal.changeType === 'delete') return '';
    if (proposal.changeType === 'create' || !proposal.range) return proposal.proposed;
    return applyRange(content, proposal.range, proposal.proposed);
  }

  private markStale(projectId: string, proposal: EditProposal): void {
    const stale = this.repos.proposals.transition(projectId, proposal.id, 'pending', 'stale');
    if (stale) this.publish(stale);
  }

  private async sweep(projectId: string, paths: string[]): Promise<void> {
    try {
      for (const path of paths) {
        const pending = this.repos.proposals.list(projectId, { status: 'pending' }).filter((p) => p.file === path || p.file.startsWith(`${path}/`));
        for (const proposal of pending) {
          const file = await this.current(projectId, proposal.file);
          if (!this.matchesBase(proposal, file)) this.markStale(projectId, proposal);
        }
      }
    } catch {
      // The project may have been deleted meanwhile; nothing to mark.
    }
  }

  private publish(proposal: EditProposal): void {
    this.events.publish({ type: 'ai.proposal.updated', projectId: proposal.projectId, proposal });
  }
}
