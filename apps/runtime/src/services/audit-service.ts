import type { FastifyBaseLogger } from 'fastify';
import type { AuditInput, AuditRepository } from '@research-studio/database';
import type { AuditEvent } from '@research-studio/shared-types';

/** Records security-relevant events. Never throws: auditing must not break requests. */
export class AuditService {
  constructor(
    private readonly repo: AuditRepository,
    private readonly log: FastifyBaseLogger,
  ) {}

  record(event: AuditInput): void {
    try {
      this.repo.append(event);
    } catch (err) {
      this.log.error({ err, event: event.action }, 'failed to write audit event');
    }
    if (event.outcome !== 'success') {
      this.log.warn({ audit: event }, `audit: ${event.action} ${event.outcome}`);
    }
  }

  list(query: { limit: number; projectId?: string | undefined }): AuditEvent[] {
    return this.repo.list(query.projectId ? { limit: query.limit, projectId: query.projectId } : { limit: query.limit });
  }
}
