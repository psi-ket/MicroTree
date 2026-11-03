// Scholarly document model (M3.3): extractor-independent structures,
// coordinates and their transformations, sentence segmentation, search-text
// normalisation, provenance and versioning. Pure and isomorphic: the web app
// uses the coordinate transforms to place highlights.

export * from './documents/model';
export * from './coordinates/coordinates';
export * from './sentences/sentence-segmenter';
export * from './text/normalize';
export * from './sections/section-classifier';
export * from './provenance/provenance';
export * from './versioning/versioning';
