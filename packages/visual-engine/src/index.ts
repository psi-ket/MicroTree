// Visual intelligence engine (M4): image validation and preprocessing,
// structured output contracts, provider routing and consent, prompts and
// orchestration, LaTeX generators and validators, plot digitising,
// refinement and isolated compilation.
export * from './errors/visual-errors';
export * from './preprocessing/image-validator';
export * from './preprocessing/image-normalizer';
export * from './preprocessing/svg-sanitizer';
export * from './schemas/visual-task.schema';
export * from './schemas/equation.schema';
export * from './schemas/diagram.schema';
export * from './schemas/circuit.schema';
export * from './schemas/plot.schema';
export * from './compile/latex-safety';
export * from './compile/standalone';
export * from './compile/isolated-compiler';
export * from './equations/equation-normalizer';
export * from './equations/equation-formatter';
export * from './equations/equation-validator';
export * from './diagrams/tikz-generator';
export * from './diagrams/tikz-validator';
export * from './circuits/quantikz-generator';
export * from './circuits/circuitikz-generator';
export * from './plots/plot-digitizer';
export * from './plots/pgfplots-generator';
export * from './plots/csv-generator';
export * from './refinement/diagram-patch';
export * from './orchestrator/builders';
