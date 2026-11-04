import type { FastifyInstance } from 'fastify';
import {
  AnalyzeWritingRequest,
  AssessAllRequest,
  AssessRequest,
  ClaimParams,
  ClaimsQuery,
  EvidenceJobParams,
  ExtractClaimsRequest,
  InsertCitationRequest,
  ManuscriptReviewRequest,
  MergeClaimsRequest,
  ProjectIdParams,
  RecommendationParams,
  RecordParams,
  RejectRecommendationRequest,
  RetrieveEvidenceRequest,
  RevalidateRequest,
  ReviewEvidenceRequest,
  RewriteRequest,
  SplitClaimRequest,
  UpdateClaimRequest,
  UpdateEvidenceSettingsRequest,
} from '@research-studio/api-contracts';
import { z } from 'zod';
import { actorOf, parse } from './http';
import { clientSignal } from './routes-literature';
import type { EvidenceRuntime } from './services/evidence-runtime';
import { jobView } from './services/evidence/jobs';

const SuggestionParams = z.object({ projectId: z.string().min(1).max(80), suggestionId: z.string().min(3).max(120) });

/**
 * Evidence-linked writing routes (M5), inside the authenticated `/api/v1`
 * scope. Every claim, evidence record, recommendation and job resolves to
 * its project, which must exist; long operations run as persistent jobs.
 */
export function registerEvidenceRoutes(api: FastifyInstance, ev: EvidenceRuntime): void {
  // --------------------------------------------------------------- claims
  api.post('/claims/extract', async (request, reply) => {
    const input = parse(ExtractClaimsRequest, request.body);
    const r = await ev.extract(input, actorOf(request));
    return reply.code(r.job ? 202 : 201).send(r);
  });

  api.post('/claims/merge', async (request, reply) => {
    const { projectId, claimIds } = parse(MergeClaimsRequest, request.body);
    return reply.code(201).send(await ev.mergeClaims(projectId, claimIds, actorOf(request)));
  });

  api.get('/projects/:projectId/claims', async (request) => {
    const { projectId } = parse(ProjectIdParams, request.params);
    return ev.listClaims(projectId, parse(ClaimsQuery, request.query));
  });

  api.get('/claims/:claimId', async (request) => {
    const { claimId } = parse(ClaimParams, request.params);
    return ev.claimDetail(claimId);
  });

  api.patch('/claims/:claimId', async (request) => {
    const { claimId } = parse(ClaimParams, request.params);
    return ev.updateClaim(claimId, parse(UpdateClaimRequest, request.body), actorOf(request));
  });

  api.post('/claims/:claimId/split', async (request, reply) => {
    const { claimId } = parse(ClaimParams, request.params);
    const { parts } = parse(SplitClaimRequest, request.body);
    return reply.code(201).send(await ev.splitClaim(claimId, parts, actorOf(request)));
  });

  api.post('/claims/:claimId/anchors/reconcile', async (request) => {
    const { claimId } = parse(ClaimParams, request.params);
    const detail = await ev.claimDetail(claimId);
    const r = await ev.reconcileProject(detail.claim.projectId);
    return { ...r, claim: (await ev.claimDetail(claimId)).claim };
  });

  api.post('/projects/:projectId/anchors/reconcile', async (request) => {
    const { projectId } = parse(ProjectIdParams, request.params);
    return ev.reconcileProject(projectId);
  });

  // ------------------------------------------------------------- evidence
  api.post('/claims/:claimId/retrieve-evidence', async (request, reply) => {
    const { claimId } = parse(ClaimParams, request.params);
    const input = parse(RetrieveEvidenceRequest, request.body ?? {});
    return ev.retrieve(claimId, input, actorOf(request), clientSignal(reply));
  });

  api.get('/claims/:claimId/evidence', async (request) => {
    const { claimId } = parse(ClaimParams, request.params);
    const d = await ev.claimDetail(claimId);
    return { evidence: d.evidence, conflicts: d.conflicts };
  });

  api.post('/evidence/:recordId/assess', async (request, reply) => {
    const { recordId } = parse(RecordParams, request.params);
    return reply.code(202).send(await ev.assessRecord(recordId, parse(AssessRequest, request.body), actorOf(request)));
  });

  api.post('/claims/:claimId/assess-all', async (request, reply) => {
    const { claimId } = parse(ClaimParams, request.params);
    return reply.code(202).send(await ev.assessAll(claimId, parse(AssessAllRequest, request.body), actorOf(request)));
  });

  api.post('/claims/:claimId/revalidate', async (request, reply) => {
    const { claimId } = parse(ClaimParams, request.params);
    const r = await ev.revalidate(claimId, parse(RevalidateRequest, request.body ?? {}), actorOf(request));
    return reply.code(r.job ? 202 : 200).send(r);
  });

  api.post('/evidence/:recordId/review', async (request) => {
    const { recordId } = parse(RecordParams, request.params);
    return ev.review(recordId, parse(ReviewEvidenceRequest, request.body), actorOf(request));
  });

  // ------------------------------------------------------------ citations
  api.post('/claims/:claimId/citations/recommend', async (request) => {
    const { claimId } = parse(ClaimParams, request.params);
    return ev.recommend(claimId, actorOf(request));
  });

  api.post('/claims/:claimId/citations/insert', async (request, reply) => {
    const { claimId } = parse(ClaimParams, request.params);
    return reply.code(201).send(await ev.insertCitations(claimId, parse(InsertCitationRequest, request.body), actorOf(request)));
  });

  api.post('/citations/recommendations/:recommendationId/status', async (request) => {
    const { recommendationId } = parse(RecommendationParams, request.params);
    const { status } = parse(RejectRecommendationRequest, request.body);
    return ev.setRecommendationStatus(recommendationId, status, actorOf(request));
  });

  // -------------------------------------------------------------- writing
  api.post('/writing/analyze', { bodyLimit: 128 * 1024 }, async (request) => ev.analyzeWriting(parse(AnalyzeWritingRequest, request.body), actorOf(request)));

  api.post('/writing/rewrite', { bodyLimit: 128 * 1024 }, async (request, reply) => reply.code(202).send(await ev.rewrite(parse(RewriteRequest, request.body), actorOf(request))));

  api.get('/projects/:projectId/writing/suggestions/:suggestionId', async (request) => {
    const { projectId, suggestionId } = parse(SuggestionParams, request.params);
    return ev.writingSuggestion(projectId, suggestionId);
  });

  // --------------------------------------------------------------- review
  api.post('/projects/:projectId/review', async (request, reply) => {
    const { projectId } = parse(ProjectIdParams, request.params);
    return reply.code(202).send(await ev.startReview(projectId, parse(ManuscriptReviewRequest, request.body ?? {}), actorOf(request)));
  });

  api.get('/projects/:projectId/review', async (request) => {
    const { projectId } = parse(ProjectIdParams, request.params);
    return ev.latestReview(projectId);
  });

  api.get('/projects/:projectId/evidence-coverage', async (request) => {
    const { projectId } = parse(ProjectIdParams, request.params);
    return ev.coverage(projectId);
  });

  api.get('/projects/:projectId/evidence-markers', async (request) => {
    const { projectId } = parse(ProjectIdParams, request.params);
    return ev.markers(projectId);
  });

  // ------------------------------------------------------ settings, jobs
  api.get('/projects/:projectId/evidence-settings', async (request) => {
    const { projectId } = parse(ProjectIdParams, request.params);
    return ev.settings(projectId);
  });

  api.patch('/projects/:projectId/evidence-settings', async (request) => {
    const { projectId } = parse(ProjectIdParams, request.params);
    return ev.updateSettings(projectId, parse(UpdateEvidenceSettingsRequest, request.body), actorOf(request));
  });

  api.delete('/projects/:projectId/evidence', async (request) => {
    const { projectId } = parse(ProjectIdParams, request.params);
    return ev.deleteAnalysis(projectId, actorOf(request));
  });

  api.get('/projects/:projectId/evidence-jobs', async (request) => {
    const { projectId } = parse(ProjectIdParams, request.params);
    return ev.jobList(projectId);
  });

  api.get('/evidence/jobs/:jobId', async (request) => {
    const { jobId } = parse(EvidenceJobParams, request.params);
    return { job: jobView(ev.job(jobId)) };
  });

  api.post('/evidence/jobs/:jobId/cancel', async (request) => {
    const { jobId } = parse(EvidenceJobParams, request.params);
    const job = ev.job(jobId);
    return { job: ev.jobs.cancel(job.projectId, jobId) };
  });
}
