import { isNode, local, parseXmlSecure, type XmlNode } from '@research-studio/paper-ingestion';
import { VisualError } from '../errors/visual-errors';

/**
 * SVG is untrusted XML. The sanitiser parses it with the hardened reader
 * from M3.3 (no DTD, no entities, size, depth and node limits) and rebuilds
 * it from an allowlist: drawing elements and presentation attributes only.
 * Removed: scripts, `foreignObject`, event handlers (`on*`), animations that
 * set `href`, external references (`href`/`xlink:href` other than local
 * `#id`), `style` elements and attributes with `url(` or `@import`, and any
 * element or attribute not listed. Text content is escaped.
 */

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'textPath', 'marker', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern',
]);

const ATTRIBUTES = new Set([
  'id', 'class', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'd', 'points', 'transform', 'viewBox',
  'preserveAspectRatio', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'dominant-baseline', 'alignment-baseline', 'dx', 'dy', 'rotate', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits',
  'gradientTransform', 'x', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits', 'marker-start', 'marker-mid', 'marker-end',
  'clip-path', 'clipPathUnits', 'mask', 'patternUnits', 'patternTransform', 'version', 'xmlns', 'xmlns:xlink', 'href', 'xlink:href',
  'color', 'visibility', 'display', 'letter-spacing', 'word-spacing', 'startOffset',
]);

const URL_ATTR = new Set(['fill', 'stroke', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end']);

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

export interface SvgSanitizeResult {
  svg: string;
  removed: string[];
}

export function sanitizeSvg(source: string, maxBytes = 5 * 1024 * 1024): SvgSanitizeResult {
  let root: XmlNode;
  try {
    root = parseXmlSecure(source, { maxBytes, maxDepth: 64, maxNodes: 100_000 });
  } catch (err) {
    throw new VisualError('unsafe-svg', `The SVG was refused: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (local(root.name) !== 'svg') throw new VisualError('unsafe-svg', 'The file is not an SVG image');
  const removed = new Set<string>();

  const attrs = (n: XmlNode): string => {
    const out: string[] = [];
    for (const [name, value] of Object.entries(n.attributes)) {
      const l = name.toLowerCase();
      if (l.startsWith('on') || !ATTRIBUTES.has(name)) {
        removed.add(`attribute ${name}`);
        continue;
      }
      if ((l === 'href' || l === 'xlink:href') && !/^#[\w.-]+$/.test(value.trim())) {
        removed.add('external reference');
        continue;
      }
      if (URL_ATTR.has(l) && /url\(/i.test(value) && !/^\s*url\(\s*#[\w.-]+\s*\)\s*$/i.test(value)) {
        removed.add('external url()');
        continue;
      }
      if (/javascript:|data:|expression\(/i.test(value)) {
        removed.add(`attribute ${name}`);
        continue;
      }
      out.push(`${name}="${escapeAttr(value)}"`);
    }
    return out.length ? ` ${out.join(' ')}` : '';
  };

  const serialize = (n: XmlNode): string => {
    const name = local(n.name);
    if (!ELEMENTS.has(name)) {
      removed.add(`element ${name}`);
      return '';
    }
    const children = n.children.map((c) => (isNode(c) ? serialize(c) : name === 'text' || name === 'tspan' || name === 'title' || name === 'desc' || name === 'textPath' ? escapeText(c) : '')).join('');
    return `<${name}${attrs(n)}>${children}</${name}>`;
  };

  let svg = serialize(root);
  if (!/xmlns=/.test(svg.slice(0, 200))) svg = svg.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  return { svg, removed: [...removed].sort() };
}
