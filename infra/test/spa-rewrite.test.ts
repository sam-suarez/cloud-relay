import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface CloudFrontRequest {
  uri: string;
}
type Handler = (event: { request: CloudFrontRequest }) => CloudFrontRequest;

// The CloudFront Function is a plain script with a global handler(), not a module,
// so load it the way CloudFront does: evaluate the source and grab handler.
const source = readFileSync(new URL('../lib/functions/spa-rewrite.js', import.meta.url), 'utf8');
const handler = new Function(`${source}\nreturn handler;`)() as Handler;

const rewrite = (uri: string) => handler({ request: { uri } }).uri;

describe('SPA rewrite CloudFront Function', () => {
  it.each(['/', '/runs/abc123', '/stats/'])('serves index.html for route %s', (uri) => {
    expect(rewrite(uri)).toBe('/index.html');
  });

  it.each(['/index.html', '/assets/home-D40cgre_.js', '/favicon.ico'])(
    'passes file %s through',
    (uri) => {
      expect(rewrite(uri)).toBe(uri);
    },
  );
});
