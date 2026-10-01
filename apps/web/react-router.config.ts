import type { Config } from '@react-router/dev/config';

export default {
  // SPA mode: `react-router build` outputs static files to build/client that
  // S3 + CloudFront can serve. No server runtime is needed.
  ssr: false,
} satisfies Config;
