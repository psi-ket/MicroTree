import { z } from 'zod';
import { ModelConfidence } from './visual-task.schema';

export const EQUATION_ENVIRONMENTS = ['inline', 'equation', 'align', 'gather', 'cases', 'matrix', 'custom'] as const;
export type EquationEnvironment = (typeof EQUATION_ENVIRONMENTS)[number];

/** What the model returns for an equation image. */
export const EquationOutputSchema = z.object({
  /**
   * The mathematics only, without `$` or environment wrappers. For
   * multi-line derivations, lines are separated by `\\` and alignment
   * points marked with `&`.
   */
  latex: z.string().min(1).max(20_000),
  environment: z.enum(EQUATION_ENVIRONMENTS),
  explanation: z.string().max(2000).nullable(),
  symbolUncertainties: z
    .array(z.object({ location: z.string().max(300), alternatives: z.array(z.string().max(300)).max(6), reason: z.string().max(500) }))
    .max(50),
  /** Parts that are illegible or cut off; never filled in silently. */
  missingParts: z.array(z.string().max(300)).max(20),
  warnings: z.array(z.string().max(500)).max(30),
  confidence: ModelConfidence,
});
export type EquationOutput = z.infer<typeof EquationOutputSchema>;

/** The stored reconstruction (the model output plus identity and the formatted source). */
export interface EquationReconstruction extends EquationOutput {
  id: string;
  sourceAssetId: string | null;
  /** The complete source for the chosen environment (`$…$`, `\begin{equation}…`). */
  source: string;
}
