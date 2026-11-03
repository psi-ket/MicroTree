# 0006 — Pin TypeScript 6.0.x

## Context
TypeScript 7 (native port) is the latest release, but `typescript-eslint`
8.x supports `typescript >=4.8.4 <6.1.0`.

## Decision
Pin `typescript@~6.0.3` workspace-wide. Strict flags: `strict`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`,
`verbatimModuleSyntax`, `isolatedModules`. `exactOptionalPropertyTypes` is
left off because Radix/Monaco/Fastify typings do not support it cleanly.

## Consequences
Revisit when typescript-eslint supports TS 7.
