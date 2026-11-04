import { z } from 'zod';
import type { StructuredOutputSpec } from '@research-studio/ai-core';
import { VISUAL_TASK_TYPES } from '@research-studio/shared-types';

/**
 * Structured output contracts. Each is one Zod schema; the JSON Schema sent
 * to providers is generated from it (`z.toJSONSchema`), so what the model is
 * asked for and what the runtime accepts cannot drift apart. Every field is
 * required and optional values are `null`, as strict structured-output modes
 * (OpenAI) require. Confidence values are the model's own report, never a
 * calibrated probability.
 */
export function outputSpec<S extends z.ZodType>(name: string, schema: S): StructuredOutputSpec<z.infer<S>> {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return { name, jsonSchema, parse: (value: unknown) => schema.parse(value) };
}

export const ModelConfidence = z.number().min(0).max(1).nullable().describe('The model’s own confidence, not a calibrated probability');

export const TaskClassificationSchema = z.object({
  taskType: z.enum(VISUAL_TASK_TYPES.filter((t) => t !== 'auto' && t !== 'text-to-diagram') as [string, ...string[]]),
  alternatives: z.array(z.enum(VISUAL_TASK_TYPES.filter((t) => t !== 'auto' && t !== 'text-to-diagram') as [string, ...string[]])).max(4),
  ambiguous: z.boolean(),
  reason: z.string().max(500),
  confidence: ModelConfidence,
});
export type TaskClassification = z.infer<typeof TaskClassificationSchema>;

export const FigureExplanationSchema = z.object({
  /** What can be seen: labels, axes, components, text. */
  observations: z.array(z.object({ kind: z.enum(['label', 'axis', 'component', 'text', 'layout', 'other']), text: z.string().max(1000) })).max(100),
  visibleLabels: z.array(z.string().max(300)).max(200),
  structure: z.string().max(4000),
  /** Interpretation, kept apart from observation; never results the figure does not show. */
  interpretation: z.array(z.string().max(1000)).max(30),
  equations: z.array(z.string().max(2000)).max(30),
  caption: z.string().max(2000),
  captionAlternatives: z.array(z.string().max(2000)).max(4),
  uncertainties: z.array(z.string().max(500)).max(50),
});
export type FigureExplanation = z.infer<typeof FigureExplanationSchema>;
