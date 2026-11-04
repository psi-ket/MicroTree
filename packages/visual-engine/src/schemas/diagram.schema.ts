import { z } from 'zod';

/**
 * Intermediate diagram model. Coordinates are in centimetres with y pointing
 * up (TikZ convention); the reconstruction maps the image layout onto them.
 * Labels are LaTeX (math allowed), validated before compilation.
 */
const Id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, 'IDs are letters, digits, _ and -');
/** xcolor expressions such as `blue`, `red!60`, `blue!30!white`, or `none`. */
export const ColorExpr = z.string().regex(/^(none|[a-zA-Z]+(![0-9]{1,3}(![a-zA-Z]+)?)?)$/, 'Use an xcolor name such as blue or red!60');

export const NODE_SHAPES = ['rectangle', 'rounded', 'circle', 'ellipse', 'diamond', 'point', 'text', 'cylinder'] as const;
export const ARROWS = ['->', '<-', '<->', '-'] as const;
export const LINE_STYLES = ['solid', 'dashed', 'dotted', 'thick'] as const;
export const ANCHORS = ['center', 'above', 'below', 'left', 'right'] as const;

export const DiagramNodeSchema = z.object({
  id: Id,
  label: z.string().max(500),
  shape: z.enum(NODE_SHAPES),
  x: z.number().min(-100).max(100),
  y: z.number().min(-100).max(100),
  width: z.number().min(0).max(50).nullable(),
  height: z.number().min(0).max(50).nullable(),
  style: Id.nullable(),
  uncertain: z.boolean(),
  note: z.string().max(300).nullable(),
});

export const DiagramEdgeSchema = z.object({
  id: Id,
  from: Id,
  to: Id,
  label: z.string().max(300).nullable(),
  arrow: z.enum(ARROWS),
  line: z.enum(LINE_STYLES),
  /** Bend in degrees (positive left), or null for a straight line. */
  bend: z.number().min(-90).max(90).nullable(),
  uncertain: z.boolean(),
});

export const DiagramAnnotationSchema = z.object({
  id: Id,
  text: z.string().max(1000),
  x: z.number().min(-100).max(100),
  y: z.number().min(-100).max(100),
  anchor: z.enum(ANCHORS),
});

export const DiagramStyleSchema = z.object({
  id: Id,
  fill: ColorExpr.nullable(),
  draw: ColorExpr.nullable(),
  lineWidth: z.number().min(0.1).max(5).nullable(),
  textColor: ColorExpr.nullable(),
  font: z.enum(['normal', 'small', 'large', 'bold', 'italic']).nullable(),
});

export const DiagramOutputSchema = z.object({
  title: z.string().max(300).nullable(),
  description: z.string().max(2000).nullable(),
  nodes: z.array(DiagramNodeSchema).max(300),
  edges: z.array(DiagramEdgeSchema).max(600),
  annotations: z.array(DiagramAnnotationSchema).max(100),
  styles: z.array(DiagramStyleSchema).max(30),
  /** Components or relations the image (or description) leaves open. */
  ambiguities: z.array(z.string().max(500)).max(30),
  warnings: z.array(z.string().max(500)).max(30),
});
export type DiagramOutput = z.infer<typeof DiagramOutputSchema>;
export type DiagramNode = z.infer<typeof DiagramNodeSchema>;
export type DiagramEdge = z.infer<typeof DiagramEdgeSchema>;
export type DiagramAnnotation = z.infer<typeof DiagramAnnotationSchema>;
export type DiagramStyle = z.infer<typeof DiagramStyleSchema>;

export interface ScientificDiagram extends DiagramOutput {
  id: string;
  latex: string;
  packages: string[];
}

/** A controlled change to a diagram: operations on the structure, never a full regeneration. */
export const DiagramPatchSchema = z.object({
  operations: z
    .array(
      z.object({
        op: z.enum(['add-node', 'update-node', 'remove-node', 'add-edge', 'update-edge', 'remove-edge', 'add-annotation', 'update-annotation', 'remove-annotation', 'set-style', 'set-title']),
        /** The ID the operation changes or removes (null for additions). */
        target: Id.nullable(),
        node: DiagramNodeSchema.nullable(),
        edge: DiagramEdgeSchema.nullable(),
        annotation: DiagramAnnotationSchema.nullable(),
        style: DiagramStyleSchema.nullable(),
        title: z.string().max(300).nullable(),
      }),
    )
    .max(100),
  summary: z.string().max(1000),
  ambiguities: z.array(z.string().max(500)).max(20),
});
export type DiagramPatch = z.infer<typeof DiagramPatchSchema>;

/** A controlled change to hand-edited source: exact find/replace pairs. */
export const SourcePatchSchema = z.object({
  edits: z.array(z.object({ find: z.string().min(1).max(5000), replace: z.string().max(5000) })).max(40),
  summary: z.string().max(1000),
  ambiguities: z.array(z.string().max(500)).max(20),
});
export type SourcePatch = z.infer<typeof SourcePatchSchema>;
