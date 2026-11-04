/**
 * M5 evaluation set. SYNTHETIC: every paper and passage below was written
 * for this benchmark (titles start with "Synthetic"). They paraphrase
 * textbook-level statements and are not quotations from, or claims about,
 * real publications. Expected labels were assigned by hand when the set was
 * written and are recorded with an explanation and known limitations.
 */

export interface BenchPassage {
  key: string;
  paper: string;
  section: string;
  text: string;
}

export const PAPERS: Record<string, string> = {
  sc: 'Synthetic Notes on Surface Code Thresholds',
  bias: 'Synthetic Notes on Biased Noise',
  maj: 'Synthetic Review of Majorana Modes',
  lind: 'Synthetic Primer on Open Quantum Systems',
  tn: 'Synthetic Study of Tensor Network Simulation',
  vqe: 'Synthetic Study of Variational Eigensolvers',
  cat: 'Synthetic Notes on Cat Qubits',
  hist: 'Synthetic History of Quantum Error Correction',
};

export const PASSAGES: BenchPassage[] = [
  { key: 'sc1', paper: 'sc', section: 'Results', text: 'Using a minimum-weight perfect matching decoder we find a threshold of about one percent for the surface code under depolarising noise.' },
  { key: 'sc2', paper: 'sc', section: 'Introduction', text: 'The surface code requires only nearest-neighbour stabiliser measurements on a two-dimensional lattice, which makes it attractive for planar hardware.' },
  { key: 'sc3', paper: 'sc', section: 'Results', text: 'The logical error rate decreases exponentially with code distance when the physical error rate is below threshold.' },
  { key: 'bias1', paper: 'bias', section: 'Results', text: 'Under strongly biased dephasing noise the tailored surface code reaches thresholds far above one percent.' },
  { key: 'bias2', paper: 'bias', section: 'Discussion', text: 'These thresholds apply only when one Pauli error dominates; for unbiased noise the standard values are recovered.' },
  { key: 'maj1', paper: 'maj', section: 'Background', text: 'Majorana zero modes obey non-Abelian exchange statistics, so braiding them implements unitary gates on a degenerate ground space.' },
  { key: 'maj2', paper: 'maj', section: 'Outlook', text: 'Unambiguous experimental demonstration of braiding of Majorana zero modes has not yet been reported.' },
  { key: 'lind1', paper: 'lind', section: 'Theory', text: 'Under the Born and Markov approximations the reduced density matrix of an open quantum system obeys a Lindblad master equation.' },
  { key: 'lind2', paper: 'lind', section: 'Theory', text: 'The Lindblad form guarantees that the dynamics is completely positive and trace preserving.' },
  { key: 'tn1', paper: 'tn', section: 'Methods', text: 'Matrix product states represent one-dimensional states with bounded entanglement using a bond dimension that grows with the entanglement entropy.' },
  { key: 'tn2', paper: 'tn', section: 'Results', text: 'For gapped one-dimensional Hamiltonians the ground state obeys an area law, so matrix product states with modest bond dimension approximate it efficiently.' },
  { key: 'vqe1', paper: 'vqe', section: 'Results', text: 'On the simulated hydrogen molecule the variational eigensolver reached chemical accuracy with a hardware-efficient ansatz.' },
  { key: 'vqe2', paper: 'vqe', section: 'Discussion', text: 'Barren plateaus make gradients vanish exponentially with the number of qubits for random parameterised circuits.' },
  { key: 'cat1', paper: 'cat', section: 'Results', text: 'Bit-flip times of cat qubits increase exponentially with the mean photon number, while phase-flip rates grow only linearly.' },
  { key: 'hist1', paper: 'hist', section: 'History', text: 'The first quantum error-correcting code, a nine-qubit code, was proposed in 1995.' },
  { key: 'hist2', paper: 'hist', section: 'History', text: 'Stabiliser formalism provided a unified description of many quantum codes shortly afterwards.' },
];

export type Expected = 'direct_support' | 'partial_support' | 'contradiction' | 'context_only' | 'none';

export interface BenchClaim {
  id: string;
  category: string;
  sentence: string;
  /** Expected atomic claims (verbatim spans), in order; empty for non-claims. */
  claims: string[];
  /** Passages that state (or partly state) the claim, for retrieval; with the expected assessment per passage. */
  relevant: Record<string, Expected>;
  explanation: string;
  limitations: string;
}

export const CLAIMS: BenchClaim[] = [
  { id: 'c1', category: 'quantitative', sentence: 'The surface code threshold is about one percent for depolarising noise.', claims: ['The surface code threshold is about one percent for depolarising noise.'], relevant: { sc1: 'direct_support', bias1: 'context_only', bias2: 'context_only' }, explanation: 'sc1 states it; the biased-noise passages concern another regime.', limitations: 'Decoder-dependent value.' },
  { id: 'c2', category: 'comparative', sentence: 'Under biased noise, tailored surface codes reach higher thresholds than under depolarising noise.', claims: ['Under biased noise, tailored surface codes reach higher thresholds than under depolarising noise.'], relevant: { bias1: 'direct_support', bias2: 'partial_support', sc1: 'context_only' }, explanation: 'bias1 states the comparison.', limitations: 'Only for strongly biased noise.' },
  { id: 'c3', category: 'theoretical', sentence: 'Surface codes are widely investigated because of their locality, and they provide a framework for fault-tolerant quantum computing.', claims: ['Surface codes are widely investigated because of their locality', 'they provide a framework for fault-tolerant quantum computing.'], relevant: { sc2: 'partial_support' }, explanation: 'sc2 supports locality; nothing states the framework claim.', limitations: 'Compound sentence.' },
  { id: 'c4', category: 'empirical', sentence: 'Braiding of Majorana zero modes has been demonstrated experimentally.', claims: ['Braiding of Majorana zero modes has been demonstrated experimentally.'], relevant: { maj2: 'contradiction', maj1: 'context_only' }, explanation: 'maj2 says it has not been reported.', limitations: 'Time-dependent statement.' },
  { id: 'c5', category: 'theoretical', sentence: 'Majorana zero modes obey non-Abelian statistics.', claims: ['Majorana zero modes obey non-Abelian statistics.'], relevant: { maj1: 'direct_support' }, explanation: 'Stated in maj1.', limitations: 'None.' },
  { id: 'c6', category: 'mathematical', sentence: 'Under the Born and Markov approximations the reduced dynamics follows a Lindblad master equation.', claims: ['Under the Born and Markov approximations the reduced dynamics follows a Lindblad master equation.'], relevant: { lind1: 'direct_support', lind2: 'context_only' }, explanation: 'lind1 states it with the approximations.', limitations: 'Assumptions must be kept.' },
  { id: 'c7', category: 'theoretical', sentence: 'Lindblad dynamics is completely positive and trace preserving.', claims: ['Lindblad dynamics is completely positive and trace preserving.'], relevant: { lind2: 'direct_support' }, explanation: 'Stated in lind2.', limitations: 'None.' },
  { id: 'c8', category: 'methodological', sentence: 'We use matrix product states to simulate the one-dimensional chain.', claims: ['We use matrix product states to simulate the one-dimensional chain.'], relevant: { tn1: 'context_only' }, explanation: 'A statement about this manuscript; the source gives context only.', limitations: 'Needs no external support.' },
  { id: 'c9', category: 'theoretical', sentence: 'Ground states of gapped one-dimensional Hamiltonians obey an area law.', claims: ['Ground states of gapped one-dimensional Hamiltonians obey an area law.'], relevant: { tn2: 'direct_support', tn1: 'context_only' }, explanation: 'Stated in tn2.', limitations: 'One dimension only.' },
  { id: 'c10', category: 'empirical', sentence: 'The variational eigensolver reached chemical accuracy for the hydrogen molecule.', claims: ['The variational eigensolver reached chemical accuracy for the hydrogen molecule.'], relevant: { vqe1: 'partial_support' }, explanation: 'vqe1 reports it in simulation only.', limitations: 'Simulated, not hardware.' },
  { id: 'c11', category: 'causal', sentence: 'Barren plateaus cause gradients to vanish exponentially with the number of qubits.', claims: ['Barren plateaus cause gradients to vanish exponentially with the number of qubits.'], relevant: { vqe2: 'partial_support' }, explanation: 'vqe2 states it for random circuits only.', limitations: 'Scope narrower in the source.' },
  { id: 'c12', category: 'quantitative', sentence: 'Bit-flip times of cat qubits grow exponentially with the mean photon number.', claims: ['Bit-flip times of cat qubits grow exponentially with the mean photon number.'], relevant: { cat1: 'direct_support' }, explanation: 'Stated in cat1.', limitations: 'None.' },
  { id: 'c13', category: 'historical', sentence: 'The first quantum error-correcting code was proposed in 1995.', claims: ['The first quantum error-correcting code was proposed in 1995.'], relevant: { hist1: 'direct_support' }, explanation: 'Stated in hist1.', limitations: 'None.' },
  { id: 'c14', category: 'interpretive', sentence: 'These results suggest that biased-noise codes could lower hardware overheads.', claims: ['These results suggest that biased-noise codes could lower hardware overheads.'], relevant: { bias1: 'context_only' }, explanation: 'Interpretation; no passage states it.', limitations: 'Interpretive claim.' },
  { id: 'c15', category: 'definition', sentence: 'The code distance is defined as the minimum weight of a logical operator.', claims: ['The code distance is defined as the minimum weight of a logical operator.'], relevant: {}, explanation: 'A definition; needs no source.', limitations: 'None.' },
  { id: 'c16', category: 'quantitative', sentence: 'The logical error rate decreases exponentially with code distance below threshold.', claims: ['The logical error rate decreases exponentially with code distance below threshold.'], relevant: { sc3: 'direct_support' }, explanation: 'Stated in sc3.', limitations: 'Below threshold only.' },
  { id: 'c17', category: 'background', sentence: 'Stabiliser formalism unified the description of many quantum codes.', claims: ['Stabiliser formalism unified the description of many quantum codes.'], relevant: { hist2: 'direct_support' }, explanation: 'Stated in hist2.', limitations: 'None.' },
  { id: 'c18', category: 'comparative', sentence: 'Phase-flip rates of cat qubits grow more slowly than their bit-flip times.', claims: ['Phase-flip rates of cat qubits grow more slowly than their bit-flip times.'], relevant: { cat1: 'partial_support' }, explanation: 'cat1 gives both rates; the comparison is implied.', limitations: 'Inference needed.' },
  // Non-claims.
  { id: 'n1', category: 'non-claim', sentence: 'What limits the threshold in practice?', claims: [], relevant: {}, explanation: 'A question.', limitations: '' },
  { id: 'n2', category: 'non-claim', sentence: 'In this section, we describe the noise model.', claims: [], relevant: {}, explanation: 'A transition.', limitations: '' },
  { id: 'n3', category: 'non-claim', sentence: 'See Fig.~\\ref{fig:threshold}.', claims: [], relevant: {}, explanation: 'A pointer.', limitations: '' },
  { id: 'n4', category: 'non-claim', sentence: '\\section{Results}', claims: [], relevant: {}, explanation: 'A heading.', limitations: '' },
  { id: 'n5', category: 'non-claim', sentence: '\\cite{fowler2012}', claims: [], relevant: {}, explanation: 'A bare citation.', limitations: '' },
  { id: 'n6', category: 'non-claim', sentence: 'The rest of this paper is organised as follows.', claims: [], relevant: {}, explanation: 'Structure.', limitations: '' },
  { id: 'n7', category: 'non-claim', sentence: 'Let $H$ denote the Hamiltonian.', claims: [], relevant: {}, explanation: 'Notation.', limitations: '' },
];

/** Anchor scenarios: an edit and the expected status of the claim afterwards. */
export interface AnchorCase {
  id: string;
  kind: string;
  before: string;
  after: string;
  claim: string;
  expected: 'current' | 'modified' | 'needs_revalidation' | 'deleted' | 'unmatched';
}

const P = 'Surface codes need only local checks. The threshold is about one percent for depolarising noise. Decoders run in polynomial time.';
export const ANCHOR_CASES: AnchorCase[] = [
  { id: 'a1', kind: 'unchanged', before: P, after: P, claim: 'The threshold is about one percent for depolarising noise.', expected: 'current' },
  { id: 'a2', kind: 'minor wording', before: P, after: P.replace('need only local checks', 'need only nearby checks'), claim: 'Surface codes need only local checks.', expected: 'modified' },
  { id: 'a3', kind: 'unrelated sentence edited', before: P, after: P.replace('polynomial time', 'linear time'), claim: 'The threshold is about one percent for depolarising noise.', expected: 'current' },
  { id: 'a4', kind: 'material: number', before: P, after: P.replace('one percent', 'three percent'), claim: 'The threshold is about one percent for depolarising noise.', expected: 'needs_revalidation' },
  { id: 'a5', kind: 'material: negation', before: P, after: P.replace('Decoders run', 'Decoders do not run'), claim: 'Decoders run in polynomial time.', expected: 'needs_revalidation' },
  { id: 'a6', kind: 'material: scope', before: P, after: P.replace('for depolarising noise', 'for all noise models'), claim: 'The threshold is about one percent for depolarising noise.', expected: 'needs_revalidation' },
  { id: 'a7', kind: 'material: hedge', before: P, after: P.replace('The threshold is', 'The threshold may be'), claim: 'The threshold is about one percent for depolarising noise.', expected: 'needs_revalidation' },
  { id: 'a8', kind: 'citation added', before: P, after: P.replace('depolarising noise.', 'depolarising noise~\\cite{x}.'), claim: 'The threshold is about one percent for depolarising noise.', expected: 'current' },
  { id: 'a9', kind: 'paragraph split', before: P, after: P.replace('checks. The', 'checks.\n\nThe'), claim: 'The threshold is about one percent for depolarising noise.', expected: 'current' },
  { id: 'a10', kind: 'sentence reorder', before: P, after: 'Decoders run in polynomial time. The threshold is about one percent for depolarising noise. Surface codes need only local checks.', claim: 'Surface codes need only local checks.', expected: 'current' },
  { id: 'a11', kind: 'deleted', before: P, after: P.replace('Decoders run in polynomial time.', ''), claim: 'Decoders run in polynomial time.', expected: 'deleted' },
  { id: 'a12', kind: 'sentences merged', before: P, after: P.replace('checks. The threshold', 'checks, and the threshold'), claim: 'Surface codes need only local checks.', expected: 'modified' },
];
