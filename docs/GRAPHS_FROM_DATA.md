# Graphs from data

Open **Visual Studio → Graph from data**. Upload CSV, TSV, TXT, DAT or an
Excel XLSX workbook, paste spreadsheet cells, or use a table selected in the
project editor. For older XLS workbooks, save as XLSX or paste the cells.

Choose the worksheet, separator and whether the first row contains column
names. The table shows the first five rows. Select an X column, one or more Y
columns, and the first and last data rows to include. Every selected value
must be numeric; empty or invalid cells report their row and column instead
of being replaced with zero. Each Y column becomes a separate named series.
The **Number format** setting controls decimal and thousands separators.
Auto reads `33,574` as `33.574`. Choose **Decimal point** if that value means
`33574`, or **Decimal comma** for numbers such as `1.234,56`. Use tabs or
semicolons to separate columns containing unquoted decimal commas.
XLSX formulas use their saved results; recalculate and save in Excel first
if results are missing or outdated. Imports are limited to 5 MB, 10,000 data
rows, 100 columns, and 20 selected series.

Choose a line, scatter or bar graph, labels, linear or logarithmic axes,
dimensions, grid, legend and colour mode. Both axes currently require numeric
data. Dimensions use `cm`, `mm`, `pt` or `in`. Logarithmic axes require strictly
positive values. Click **Create graph** to create an editable PGFPlots artifact
with an exact CSV data file. Creating a graph does not require AI.

Optionally select an AI provider and model, describe a change in the result
toolbar and click **Improve**. This reuses the existing runtime AI refinement
and cloud consent flow. Refinements change LaTeX source while keeping the
imported data file. Manual axes/style regeneration produces source from the
stored settings; it replaces source-only refinements.

Review the compiled preview, approve the version and click **Insert**. Choose
the project and target file, add the caption and figure label, and review the
insertion plan, including required packages, before applying it. This uses the
existing versioned insertion and rollback workflow. Preview, approval and
insertion require a working LaTeX toolchain with TikZ and PGFPlots; source and
CSV exports remain available without it.

For a **heatmap**, choose Heatmap in Graph type. The row-values column (for
example `Pol Angle`) labels the vertical axis. Selected measurement column
headings (such as `1.7`, `1.8`, `1.10`) label the horizontal axis, preserving
their spelling and table order. Measurements set the cell colours. Select
at least two measurement columns and two rows. Both axes use equally spaced
table positions rather than numeric distances between headings.

Heatmap settings include Viridis, Hot and Greyscale palettes, an optional
colour bar and label, automatic or fixed colour limits, and placing the
first data row at the top or bottom. These settings are also available in
**Axes & style** after creation. Preview, AI refinement, export, approval
and LaTeX insertion use the same workflow as other graphs.
