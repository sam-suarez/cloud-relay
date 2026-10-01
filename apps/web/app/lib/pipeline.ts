import type { Step } from '@cloud-relay/shared';

/** Diagram nodes are the pipeline steps plus the visitor's browser. */
export type NodeId = Step | 'browser';

type Side = 'top' | 'right' | 'bottom' | 'left';

export interface NodeInfo {
  id: NodeId;
  title: string;
  service: string;
  /** What this AWS service is, in one or two sentences. */
  about: string;
  /** What it does for this upload. */
  role: string;
  /** The IAM action that makes this step possible, if any. */
  iamAction: string | null;
  position: { x: number; y: number };
}

const COL = 230;
const ROW = 160;

export const NODES: NodeInfo[] = [
  {
    id: 'browser',
    title: 'Your browser',
    service: 'Client',
    about: 'The React app, served as static files from S3 through CloudFront.',
    role: 'Asks for an upload URL, uploads the photo directly to S3, then listens for results.',
    iamAction: null,
    position: { x: 0, y: ROW },
  },
  {
    id: 'edge',
    title: 'CloudFront',
    service: 'CDN',
    about:
      "AWS's content delivery network. Like Cloudflare's edge: requests hit the nearest edge location first.",
    role: 'Receives the API call at the edge and forwards it to API Gateway.',
    iamAction: null,
    position: { x: COL, y: 0 },
  },
  {
    id: 'api',
    title: 'API Gateway',
    service: 'HTTP API',
    about: 'A managed HTTP front door for Lambdas, with routing, throttling, and auth built in.',
    role: 'Routes POST /uploads to the presign Lambda and enforces the rate limit.',
    iamAction: 'lambda:InvokeFunction',
    position: { x: COL * 2, y: 0 },
  },
  {
    id: 'presign',
    title: 'Lambda · presign',
    service: 'Lambda',
    about: 'Runs a function on demand and bills per millisecond. Similar to a Vercel Function.',
    role: 'Signs a short-lived S3 PUT URL with size and content-type limits.',
    iamAction: 's3:PutObject',
    position: { x: COL * 3, y: 0 },
  },
  {
    id: 'upload',
    title: 'S3 · uploads',
    service: 'S3',
    about: 'Object storage. Buckets hold files; access is denied unless a policy allows it.',
    role: 'Accepts the photo straight from the browser, so the file never passes through a Lambda.',
    iamAction: 's3:PutObject (via presigned URL)',
    position: { x: COL * 4, y: 0 },
  },
  {
    id: 'enqueue',
    title: 'SQS',
    service: 'Queue',
    about: 'A managed message queue. Messages wait until a consumer processes and deletes them.',
    role: 'Buffers the "new upload" event and retries the worker if it fails.',
    iamAction: 'sqs:SendMessage',
    position: { x: COL * 4, y: ROW },
  },
  {
    id: 'resize',
    title: 'Lambda · worker',
    service: 'Lambda',
    about: 'The same Lambda service, triggered by SQS instead of HTTP.',
    role: 'Downloads the original and writes resized WebP thumbnails with sharp.',
    iamAction: 's3:GetObject, s3:PutObject',
    position: { x: COL * 3, y: ROW },
  },
  {
    id: 'moderate',
    title: 'Rekognition · moderation',
    service: 'Rekognition',
    about: 'Pre-trained image analysis. No model to train or host.',
    role: 'Rejects inappropriate images before anything is stored.',
    iamAction: 'rekognition:DetectModerationLabels',
    position: { x: COL * 2, y: ROW },
  },
  {
    id: 'label',
    title: 'Rekognition · labels',
    service: 'Rekognition',
    about: 'The same service, asked a different question.',
    role: 'Tags the photo with what is in it ("Dog", "Beach", ...).',
    iamAction: 'rekognition:DetectLabels',
    position: { x: COL, y: ROW },
  },
  {
    id: 'persist',
    title: 'DynamoDB',
    service: 'Database',
    about: 'Serverless key-value database with single-digit-millisecond reads at any scale.',
    role: 'Saves the image record under your session ID.',
    iamAction: 'dynamodb:PutItem',
    position: { x: COL, y: ROW * 2 },
  },
  {
    id: 'notify',
    title: 'API Gateway · WebSocket',
    service: 'WebSocket API',
    about: 'Keeps a WebSocket open to each browser; Lambdas push messages through it.',
    role: 'Pushes each step event to your browser as it happens.',
    iamAction: 'execute-api:ManageConnections',
    position: { x: 0, y: ROW * 2 },
  },
];

export interface EdgeInfo {
  from: NodeId;
  to: NodeId;
  fromSide: Side;
  toSide: Side;
}

/** Laid out as a snake: left to right, down, right to left, down, back to the browser. */
export const EDGES: EdgeInfo[] = [
  { from: 'browser', to: 'edge', fromSide: 'right', toSide: 'left' },
  { from: 'edge', to: 'api', fromSide: 'right', toSide: 'left' },
  { from: 'api', to: 'presign', fromSide: 'right', toSide: 'left' },
  { from: 'presign', to: 'upload', fromSide: 'right', toSide: 'left' },
  { from: 'upload', to: 'enqueue', fromSide: 'bottom', toSide: 'top' },
  { from: 'enqueue', to: 'resize', fromSide: 'left', toSide: 'right' },
  { from: 'resize', to: 'moderate', fromSide: 'left', toSide: 'right' },
  { from: 'moderate', to: 'label', fromSide: 'left', toSide: 'right' },
  { from: 'label', to: 'persist', fromSide: 'bottom', toSide: 'top' },
  { from: 'persist', to: 'notify', fromSide: 'left', toSide: 'right' },
  { from: 'notify', to: 'browser', fromSide: 'top', toSide: 'bottom' },
];

export function nodeInfo(id: NodeId): NodeInfo {
  const info = NODES.find((n) => n.id === id);
  if (!info) throw new Error(`Unknown node: ${id}`);
  return info;
}
