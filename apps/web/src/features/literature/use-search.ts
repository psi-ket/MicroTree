import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { InterpretedQuery, LiteratureSearchRequest, ProviderSearchOutcome, RankedWork } from '@research-studio/shared-types';
import { runtime } from '../../lib/connection';
import { errorMessage, queryClient } from '../../lib/queries';

export type SearchPhase = 'idle' | 'searching' | 'loading-more' | 'done' | 'error' | 'cancelled';

export interface SearchState {
  phase: SearchPhase;
  /** The request behind the results shown (no cursor). */
  request: LiteratureSearchRequest | null;
  results: RankedWork[];
  /** Status of the most recent page, per provider. */
  providerStatus: ProviderSearchOutcome[];
  query: InterpretedQuery | null;
  total: number | null;
  nextCursor: string | null;
  error: string | null;
}

const INITIAL: SearchState = { phase: 'idle', request: null, results: [], providerStatus: [], query: null, total: null, nextCursor: null, error: null };

type Action =
  | { type: 'start'; request: LiteratureSearchRequest }
  | { type: 'more' }
  | { type: 'page'; append: boolean; results: RankedWork[]; providerStatus: ProviderSearchOutcome[]; query: InterpretedQuery; total: number | null; nextCursor: string | null }
  | { type: 'error'; message: string; append: boolean }
  | { type: 'cancelled'; append: boolean };

function reduce(state: SearchState, action: Action): SearchState {
  switch (action.type) {
    case 'start':
      return { ...INITIAL, phase: 'searching', request: action.request };
    case 'more':
      return { ...state, phase: 'loading-more', error: null };
    case 'page': {
      const seen = new Set(action.append ? state.results.map((r) => r.work.id) : []);
      const fresh = action.results.filter((r) => !seen.has(r.work.id));
      return {
        ...state,
        phase: 'done',
        results: action.append ? [...state.results, ...fresh] : action.results,
        providerStatus: action.providerStatus,
        query: action.query,
        total: action.total,
        nextCursor: action.nextCursor,
        error: null,
      };
    }
    case 'error':
      // A failed "load more" keeps the results already shown.
      return action.append ? { ...state, phase: 'done', error: action.message } : { ...state, phase: 'error', error: action.message };
    case 'cancelled':
      return action.append ? { ...state, phase: 'done' } : { ...state, phase: 'cancelled' };
  }
}

/**
 * One literature search at a time. A new search supersedes (and cancels) the
 * previous one; `cancel` aborts the request, which the runtime passes on to
 * the providers.
 */
export function useLiteratureSearch() {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const inflight = useRef<AbortController | null>(null);

  const execute = useCallback(async (request: LiteratureSearchRequest, cursor: string | null) => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    const append = cursor !== null;
    dispatch(append ? { type: 'more' } : { type: 'start', request });
    try {
      const res = await runtime().literature.search({ ...request, ...(cursor ? { cursor } : {}) }, controller.signal);
      if (controller.signal.aborted) return;
      dispatch({
        type: 'page',
        append,
        results: res.results,
        providerStatus: res.providerStatus,
        query: res.query,
        total: res.total,
        nextCursor: res.pagination.hasMore ? res.pagination.nextCursor : null,
      });
      if (!append) void queryClient.invalidateQueries({ queryKey: ['literature', 'history'] });
      // Provider health changed: the Sources dialog should show it.
      void queryClient.invalidateQueries({ queryKey: ['literature', 'providers'] });
    } catch (err) {
      // Superseded by a newer search: that one owns the state now.
      if (inflight.current !== controller) return;
      if (controller.signal.aborted) dispatch({ type: 'cancelled', append });
      else dispatch({ type: 'error', message: errorMessage(err), append });
    } finally {
      if (inflight.current === controller) inflight.current = null;
    }
  }, []);

  const search = useCallback((request: LiteratureSearchRequest) => execute(request, null), [execute]);

  const loadMore = useCallback(() => {
    if (state.request && state.nextCursor && state.phase === 'done') void execute(state.request, state.nextCursor);
  }, [execute, state.request, state.nextCursor, state.phase]);

  const cancel = useCallback(() => inflight.current?.abort(), []);

  useEffect(() => () => inflight.current?.abort(), []);

  return { state, search, loadMore, cancel, busy: state.phase === 'searching' || state.phase === 'loading-more' };
}
