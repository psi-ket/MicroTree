# 0005 — Harden latexmk invocation

## Context
`latexmkrc` files are Perl and are executed by latexmk, including one found in
the project directory. TeX's `\write18` can run shell commands.

## Decision
Spawn: `latexmk -norc -<engine flag> -interaction=nonstopmode -file-line-error
-synctex=1 -outdir=.rs-build <main.tex>` with `shell:false`.
Environment overrides (kpathsea reads texmf.cnf variables from the environment):
`shell_escape=f`, `openout_any=p`, `max_print_line=10000`, `error_line=254`,
`half_error_line=238`. The long line settings make the log parser robust
(no 79-column wrapping).

*Amended by [0008](0008-m2-1-hardening.md):* `openin_any=p` for pdfLaTeX and
XeLaTeX (`a` for LuaLaTeX, which cannot start under `p`), and projects
containing links that resolve outside them are not compiled.

## Consequences
+ Untrusted projects cannot execute code through the build.
− Packages requiring shell escape (minted, some tikz externalisation) do not work yet.
