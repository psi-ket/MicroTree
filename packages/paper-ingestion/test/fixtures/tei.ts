/**
 * A synthetic TEI document in the shape GROBID 0.8/0.9 produces for
 * `processFulltextDocument` with `segmentSentences=1`, `teiCoordinates` and
 * `includeRawCitations=1`. The text is written for the tests (it is not taken
 * from any paper). Page 1 and 2 are US Letter (612 × 792).
 */
export const SAMPLE_TEI = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xml:space="preserve" xmlns="http://www.tei-c.org/ns/1.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xlink="http://www.w3.org/1999/xlink">
  <teiHeader xml:lang="en">
    <fileDesc>
      <titleStmt>
        <title level="a" type="main" coords="1,72.00,80.00,468.00,18.00">Bosonic Codes and the Lindblad Master Equation</title>
      </titleStmt>
      <publicationStmt>
        <publisher/>
        <availability status="unknown"><licence/></availability>
        <date type="published" when="2024-03-15">15 March 2024</date>
      </publicationStmt>
      <sourceDesc>
        <biblStruct>
          <analytic>
            <author>
              <persName coords="1,200.00,110.00,80.00,10.00"><forename type="first">Ada</forename><forename type="middle">Q</forename><surname>Example</surname></persName>
              <email>ada@example.org</email>
              <affiliation key="aff0"><orgName type="department">Department of Physics</orgName><orgName type="institution">Example University</orgName><address><country>Nowhere</country></address></affiliation>
            </author>
            <author>
              <persName><forename type="first">Bo</forename><surname>Sample</surname></persName>
            </author>
            <title level="a" type="main">Bosonic Codes and the Lindblad Master Equation</title>
          </analytic>
          <monogr><title level="j">Journal of Synthetic Physics</title><imprint><date type="published" when="2024-03-15"/></imprint></monogr>
          <idno type="DOI">10.1234/JSP.2024.001</idno>
          <idno type="arXiv">arXiv:2403.01234v2</idno>
        </biblStruct>
      </sourceDesc>
    </fileDesc>
    <encodingDesc><appInfo><application version="0.8.2" ident="GROBID" when="2026-11-03T10:00+0000"><desc>GROBID</desc></application></appInfo></encodingDesc>
    <profileDesc>
      <textClass><keywords><term>quantum error correction</term><term>bosonic codes</term></keywords></textClass>
      <abstract>
        <div xmlns="http://www.tei-c.org/ns/1.0"><p><s coords="1,72.00,150.00,468.00,10.00">We study bosonic codes under the Lindblad master equation.</s><s coords="1,72.00,162.00,300.00,10.00">The cat code &amp; the GKP code are compared.</s></p></div>
      </abstract>
    </profileDesc>
  </teiHeader>
  <facsimile>
    <surface n="1" ulx="0.0" uly="0.0" lrx="612.0" lry="792.0"/>
    <surface n="2" ulx="0.0" uly="0.0" lrx="612.0" lry="792.0"/>
  </facsimile>
  <text xml:lang="en">
    <body>
      <div xmlns="http://www.tei-c.org/ns/1.0"><head n="1" coords="1,72.00,200.00,100.00,12.00">Introduction</head>
        <p><s coords="1,72.00,220.00,220.00,10.00;1,72.00,232.00,180.00,10.00">Quantum error correction protects fragile states <ref type="bibr" target="#b0" coords="1,250.00,232.00,10.00,10.00">[1]</ref>.</s><s coords="1,72.00,244.00,200.00,10.00">Majorana zero modes are a different route <ref type="bibr" target="#b1">[2]</ref>.</s></p>
      </div>
      <div xmlns="http://www.tei-c.org/ns/1.0"><head n="2" coords="1,72.00,280.00,100.00,12.00">Model</head>
        <p><s coords="1,72.00,300.00,220.00,10.00">The density matrix <formula>ρ</formula> evolves under a Hamiltonian H_2 with loss rate κ.</s></p>
        <formula xml:id="formula_0" coords="1,100.00,330.00,300.00,20.00">dρ/dt = -i[H, ρ] + κ D[a]ρ<label>(1)</label></formula>
      </div>
      <div xmlns="http://www.tei-c.org/ns/1.0"><head n="2.1" coords="1,72.00,380.00,120.00,12.00">Cat codes</head>
        <p><s coords="1,72.00,400.00,220.00,10.00">Cat codes use superpositions of coherent states, see Fig. <ref type="figure" target="#fig_0">1</ref> and Table <ref type="table" target="#tab_0">1</ref>.</s></p>
      </div>
      <figure xmlns="http://www.tei-c.org/ns/1.0" xml:id="fig_0" coords="2,72.00,80.00,220.00,160.00"><head>Fig. 1.</head><label>1</label><figDesc>Wigner function of a cat state.</figDesc><graphic coords="2,72.00,80.00,220.00,140.00" type="bitmap"/></figure>
      <figure xmlns="http://www.tei-c.org/ns/1.0" type="table" xml:id="tab_0" coords="2,320.00,80.00,220.00,100.00"><head>Table 1.</head><label>1</label><figDesc>Logical error rates per code.</figDesc><table><row><cell>Code</cell><cell>Rate</cell></row><row><cell>cat</cell><cell>0.01</cell></row></table></figure>
      <div xmlns="http://www.tei-c.org/ns/1.0"><head n="3" coords="2,72.00,300.00,100.00,12.00">Results</head>
        <p><s coords="2,72.00,320.00,220.00,10.00">Tensor networks simulate the dynamics efficiently.</s><s coords="2,72.00,332.00,220.00,10.00">Hamiltonian simulation needs fewer gates.</s></p>
        <p><s coords="2,72.00,320.00,220.00,10.00">Tensor networks simulate the dynamics efficiently.</s><s coords="2,72.00,332.00,220.00,10.00">Hamiltonian simulation needs fewer gates.</s></p>
        <list><item>first finding</item><item>second finding</item></list>
      </div>
      <note xmlns="http://www.tei-c.org/ns/1.0" place="foot" n="1" xml:id="foot_0" coords="2,72.00,740.00,300.00,8.00">A footnote about topological phases.</note>
    </body>
    <back>
      <div type="acknowledgement">
        <div xmlns="http://www.tei-c.org/ns/1.0"><head>Acknowledgements</head><p><s>We thank the synthetic funding agency.</s></p></div>
      </div>
      <div type="annex">
        <div xmlns="http://www.tei-c.org/ns/1.0"><head n="A">Appendix A: Derivation</head><p>The derivation follows from Eq. (1).</p></div>
      </div>
      <div type="references">
        <listBibl>
          <biblStruct xml:id="b0" coords="2,320.00,600.00,220.00,9.00;2,320.00,610.00,200.00,9.00">
            <analytic><title level="a" type="main">Scheme for reducing decoherence in quantum computer memory</title><author><persName><forename type="first">P</forename><forename type="middle">W</forename><surname>Shor</surname></persName></author></analytic>
            <monogr><title level="j">Physical Review A</title><imprint><biblScope unit="volume">52</biblScope><biblScope unit="page" from="2493" to="2496"/><date type="published" when="1995"/></imprint></monogr>
            <idno type="DOI">10.1103/PhysRevA.52.R2493</idno>
            <note type="raw_reference">P. W. Shor, Scheme for reducing decoherence in quantum computer memory, Phys. Rev. A 52, R2493 (1995).</note>
          </biblStruct>
          <biblStruct xml:id="b1">
            <analytic><title level="a" type="main">Attention is all you need</title></analytic>
            <monogr><title level="m">Advances in Neural Information Processing Systems</title><imprint><date type="published" when="2017"/></imprint></monogr>
            <idno type="arXiv">arXiv:1706.03762</idno>
          </biblStruct>
        </listBibl>
      </div>
    </back>
  </text>
</TEI>`;

/** A TEI document with a header only (GROBID found no body). */
export const HEADER_ONLY_TEI = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title level="a" type="main">Only a title</title></titleStmt></fileDesc></teiHeader><text><body/><back/></text></TEI>`;
