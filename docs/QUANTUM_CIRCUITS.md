# Quantum and electrical circuits (M4)

## 1. Quantum circuits (Quantikz)

The model returns `QuantumCircuitOutputSchema`
(`packages/visual-engine/src/schemas/circuit.schema.ts`): the number of
`qubits`, their `qubitLabels` (such as `\ket{0}` or `q_1`), `classicalBits`,
and `operations`, each with `kind` (`gate`, `controlled`, `measure`, `swap`, `barrier`, `reset`), `gate`, `targets`, `controls`, `parameter` (for rotations),
`label`, `column` (the time step read from the image), `classicalTarget`,
`uncertain` and `confidence`.

Known gate names are `X`, `Y`, `Z`, `H`, `S`, `Sdg`, `T`, `Tdg`, `Rx`, `Ry`,
`Rz`, `P`, `U`, `I`, `SX` and `CustomGate`; anything else is drawn as a
labelled box with a warning.

`validateQuantumCircuit` checks wire indices, that no qubit is used twice
in one operation (control and target), that controlled operations have
controls and others do not, that a swap acts on two qubits, measurements on
one qubit and an existing classical bit, and that a gate on several qubits
acts on adjacent wires (one box). Unknown gate names and uncertain operations
are warnings. `scheduleColumns` keeps the image's columns and moves
operations that would overlap on a wire into the next free column.

`generateQuantikz` writes a `quantikz` environment:

| Operation | Quantikz |
| --- | --- |
| idle wire | `\qw` |
| gate | `\gate{H}`, `\gate{R_z(\theta)}` |
| gate on adjacent qubits | `\gate[wires=n]{U}` |
| reset | `\gate{\ket{0}}` |
| controlled | `\ctrl{offset}` on controls; `\targ{}` for X, `\control{}` for Z, otherwise `\gate{…}` |
| swap | `\swap{offset}` and `\targX{}` |
| measurement | `\meter{}`, then `\cw` on that wire |
| barrier | `\slice{}` |

Qubit labels are wrapped in `$…$` unless they already contain math mode.
Uncertain operations are listed in the warnings. Packages: `tikz`,
`quantikz`, `braket`.

## 2. Electrical circuits (Circuitikz)

`ElectricalCircuitOutputSchema`: `nodes` (`id`, position, `junction`,
`label`) and `components` (`type`, `from`, `to`, `label`, `value`,
`uncertain`). Types: resistor, capacitor, inductor, voltage and current
source, battery, diode, LED, switch, lamp, ammeter, voltmeter, ground and
wire.

`validateElectricalCircuit` checks that components connect known nodes and
that only ground has one terminal. `generateCircuitikz` draws each component
between its node coordinates (`to[R, l={$R_1 = 10\,\Omega$}]`), with braced
labels so commas in values do not break the options, ground symbols, and
`circ` dots on junctions. Uncertain components are drawn dashed.

## 3. Tests

Bell circuit, controlled and multi-qubit gates, swaps, measurements with
classical wires, barriers and an RLC circuit compile with pdfLaTeX in
`packages/visual-engine/test/generators.test.ts`; validation errors are
covered there too. Missing packages (`quantikz` not installed) are reported
with an install hint and never installed.
