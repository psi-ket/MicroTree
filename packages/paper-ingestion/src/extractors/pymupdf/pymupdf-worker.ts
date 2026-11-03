/**
 * The Python program run by `PyMuPdfClient`. It is kept in this module as a
 * string (like the pdf.js worker in `research-library`) so the bundled
 * runtime carries it without extra files, and is passed with `-c`.
 *
 * Protocol: the PDF arrives on stdin, options as one JSON argument, the
 * result leaves on stdout as one JSON object. The program writes no files,
 * opens no network connections and does not run anything in the PDF
 * (PyMuPDF does not execute PDF JavaScript). It removes the current folder
 * from `sys.path` before importing anything else, so a planted module in the
 * working directory cannot be loaded, and on POSIX it caps its own address
 * space.
 *
 * Coordinates are PyMuPDF's: points, origin at the top-left of the CropBox,
 * unrotated page frame.
 */
export const PYMUPDF_WORKER_SOURCE = String.raw`
import sys
sys.path = [p for p in sys.path if p not in ('', '.')]
import json

def main():
    opts = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    try:
        import resource
        limit = int(opts.get('memoryMb', 1536)) * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except Exception:
        pass
    import pymupdf
    data = sys.stdin.buffer.read()
    out = {'version': pymupdf.VersionBind, 'pages': [], 'truncated': False}
    try:
        doc = pymupdf.open(stream=data, filetype='pdf')
    except Exception as e:
        out['error'] = {'code': 'malformed', 'message': str(e)[:300]}
        print(json.dumps(out))
        return
    if doc.needs_pass:
        out['error'] = {'code': 'unsupported', 'message': 'The PDF is password protected'}
        print(json.dumps(out))
        return
    out['pageCount'] = doc.page_count
    meta = doc.metadata or {}
    out['metadata'] = {k: (meta.get(k) or None) for k in ('title', 'author', 'subject', 'keywords', 'creator', 'producer', 'format')}
    max_pages = int(opts.get('maxPages', 500))
    if doc.page_count > max_pages:
        out['error'] = {'code': 'too-many-pages', 'message': 'The PDF has %d pages; the limit is %d' % (doc.page_count, max_pages)}
        print(json.dumps(out))
        return
    flags = pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_PRESERVE_LIGATURES | pymupdf.TEXT_MEDIABOX_CLIP
    want_words = bool(opts.get('words', False))
    max_chars = int(opts.get('maxChars', 20000000))
    total = 0
    for page in doc:
        d = page.get_text('dict', flags=flags)
        mb = page.mediabox
        cb = page.cropbox
        h = mb.y1
        blocks = []
        chars = 0
        for b in d.get('blocks', []):
            if b.get('type') != 0:
                continue
            lines = []
            for l in b.get('lines', []):
                spans = []
                for s in l.get('spans', []):
                    t = s.get('text', '')
                    if not t:
                        continue
                    chars += len(t.strip())
                    spans.append({'text': t, 'size': round(s.get('size', 0), 2), 'flags': s.get('flags', 0), 'font': s.get('font', '')[:64], 'bbox': [round(v, 2) for v in s['bbox']]})
                if spans:
                    lines.append({'bbox': [round(v, 2) for v in l['bbox']], 'dir': [round(v, 3) for v in l.get('dir', (1, 0))], 'spans': spans})
            if lines:
                blocks.append({'bbox': [round(v, 2) for v in b['bbox']], 'lines': lines})
        total += chars
        entry = {
            'number': page.number + 1,
            'width': d.get('width'),
            'height': d.get('height'),
            'rotation': page.rotation,
            'mediaBox': [mb.x0, mb.y0, mb.x1, mb.y1],
            'cropBox': [cb.x0, h - cb.y1, cb.x1, h - cb.y0],
            'imageCount': len(page.get_images(full=False)),
            'charCount': chars,
            'blocks': blocks,
        }
        if want_words:
            entry['words'] = [[round(w[0], 2), round(w[1], 2), round(w[2], 2), round(w[3], 2), w[4]] for w in page.get_text('words', flags=flags)]
        out['pages'].append(entry)
        if total > max_chars:
            out['truncated'] = True
            break
    print(json.dumps(out))

main()
`;
