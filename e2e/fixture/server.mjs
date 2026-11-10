// A tiny shop for the KeepGreen end-to-end check: a home page with a search box.
import http from 'node:http';

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>Tiny Shop</title></head><body>${body}</body></html>`;
const ITEMS = ['Red shoes', 'Blue shoes', 'Green hat'];

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/') {
      res.end(page('<h1>Tiny Shop</h1><form action="/search"><label>Search <input name="q"></label><button type="submit">Search</button></form>'));
    } else if (url.pathname === '/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const hits = ITEMS.filter((i) => i.toLowerCase().includes(q));
      res.end(page(`<h1>Results</h1><p role="status">${hits.length} result(s)</p><ul>${hits.map((h) => `<li>${h}</li>`).join('')}</ul>`));
    } else {
      res.statusCode = 404;
      res.end(page('<h1>Not found</h1>'));
    }
  })
  .listen(Number(process.env.PORT ?? 4173), '127.0.0.1');
