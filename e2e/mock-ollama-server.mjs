// A tiny Ollama-compatible vision server for end-to-end tests. It reports
// vision for models whose name contains "vision", and answers structured
// requests (`format` = JSON schema) with a fixed reconstruction chosen from
// the schema's fields. It never looks at the image beyond checking one was sent.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_OLLAMA_PORT ?? 4497);

const EQUATION = {
  latex: 'i\\hbar \\frac{\\partial}{\\partial t} \\lvert \\psi \\rangle = \\hat{H} \\lvert \\psi \\rangle',
  environment: 'equation',
  explanation: 'The time-dependent Schrödinger equation.',
  symbolUncertainties: [{ location: '\\hat{H}', alternatives: ['H'], reason: 'The hat is faint' }],
  missingParts: [],
  warnings: [],
  confidence: 0.8,
};

const PLOT = {
  plotType: 'line',
  title: null,
  xAxis: { label: 'Time', unit: 'us', scale: 'linear', reversed: false, min: 0, max: 10, calibration: [{ pixel: 50, value: 0 }, { pixel: 350, value: 10 }] },
  yAxis: { label: 'Population', unit: null, scale: 'linear', reversed: false, min: 0, max: 1, calibration: [{ pixel: 250, value: 0 }, { pixel: 50, value: 1 }] },
  series: [{ name: 'Ground state', color: 'blue', marker: 'circle', line: 'solid', pixelPoints: [{ px: 50, py: 50, errLowPy: null, errHighPy: null }, { px: 200, py: 150, errLowPy: null, errHighPy: null }, { px: 350, py: 230, errLowPy: null, errHighPy: null }], estimatedValues: [] }],
  legendPosition: 'north east',
  annotations: [],
  warnings: [],
};

function answerFor(schema) {
  const keys = Object.keys(schema?.properties ?? {});
  if (keys.includes('latex')) return EQUATION;
  if (keys.includes('series')) return PLOT;
  if (keys.includes('taskType')) return { taskType: 'equation', alternatives: [], ambiguous: false, reason: 'A single formula', confidence: 0.9 };
  return null;
}

let requests = 0;
createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/__stats') return json(200, { requests });
  if (url.pathname === '/api/tags') return json(200, { models: [{ name: 'llava-vision-mock', model: 'llava-vision-mock', size: 1, details: {} }] });
  if (url.pathname === '/api/show') {
    const body = JSON.parse(raw || '{}');
    return json(200, { capabilities: String(body.model ?? '').includes('vision') ? ['completion', 'vision'] : ['completion'] });
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    requests++;
    const body = JSON.parse(raw);
    const images = body.messages.flatMap((m) => m.images ?? []).length;
    const answer = answerFor(body.format);
    if (!answer || images === 0) return json(400, { error: 'unexpected request in the mock' });
    return json(200, { model: body.model, message: { role: 'assistant', content: JSON.stringify(answer) }, done: true, done_reason: 'stop', prompt_eval_count: 900, eval_count: 120 });
  }
  json(404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => console.info(`mock Ollama on http://127.0.0.1:${PORT}`));
