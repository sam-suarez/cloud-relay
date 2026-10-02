// CloudFront Function (cloudfront-js-2.0 runtime). Runs at the edge on every viewer
// request, before the cache lookup. Client-side routes like /runs/abc have no file in
// S3, so we serve the SPA shell and let React Router render them. Anything that looks
// like a file (/assets/app.js, /favicon.ico) passes through unchanged.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- CloudFront calls handler()
function handler(event) {
  const request = event.request;
  const lastSegment = request.uri.split('/').pop();

  if (!lastSegment.includes('.')) {
    request.uri = '/index.html';
  }

  return request;
}
