import { z } from 'zod';

/**
 * Pipeline steps, in the order a successful upload goes through them.
 * Each step is emitted by the backend component that performs it.
 */
export const STEPS = [
  'edge', // CloudFront receives the API request
  'api', // API Gateway (HTTP) routes it to the presign Lambda
  'presign', // Lambda signs an S3 PUT URL
  'upload', // Browser PUTs the file straight to S3
  'enqueue', // S3 event notification lands in SQS
  'resize', // Worker Lambda resizes with sharp
  'moderate', // Rekognition DetectModerationLabels
  'label', // Rekognition DetectLabels
  'persist', // Image record written to DynamoDB
  'notify', // API Gateway WebSocket pushes the result to the browser
] as const;

export const StepSchema = z.enum(STEPS);
export type Step = z.infer<typeof StepSchema>;

export const ServiceSchema = z.enum([
  'cloudfront',
  'api-gateway-http',
  'lambda',
  's3',
  'sqs',
  'rekognition',
  'dynamodb',
  'api-gateway-websocket',
]);
export type Service = z.infer<typeof ServiceSchema>;

export const StepStatusSchema = z.enum(['started', 'succeeded', 'failed']);
export type StepStatus = z.infer<typeof StepStatusSchema>;

/** Where the log line for this step lives, so the UI can link to it. */
export const LogRefSchema = z.object({
  logGroup: z.string().min(1),
  requestId: z.string().min(1),
});
export type LogRef = z.infer<typeof LogRefSchema>;

/** Flat key/value facts about what the step did, e.g. { width: 320, bytes: 18234 }. */
export const StepDetailSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
export type StepDetail = z.infer<typeof StepDetailSchema>;

/**
 * One event per step transition. The browser's diagram only ever animates in
 * response to these. There is no client-side timer that pretends work happened.
 */
export const StepEventSchema = z.object({
  runId: z.uuid(),
  sessionId: z.uuid(),
  step: StepSchema,
  service: ServiceSchema,
  status: StepStatusSchema,
  startedAt: z.iso.datetime(),
  // null while the step is still running ("started" events)
  durationMs: z.number().int().nonnegative().nullable(),
  detail: StepDetailSchema,
  // null when no log line exists, e.g. for steps AWS performs without our code
  logRef: LogRefSchema.nullable(),
});
export type StepEvent = z.infer<typeof StepEventSchema>;

/** Which AWS service performs each step. Used by emitters and the diagram. */
export const STEP_SERVICE: Record<Step, Service> = {
  edge: 'cloudfront',
  api: 'api-gateway-http',
  presign: 'lambda',
  upload: 's3',
  enqueue: 'sqs',
  resize: 'lambda',
  moderate: 'rekognition',
  label: 'rekognition',
  persist: 'dynamodb',
  notify: 'api-gateway-websocket',
};

/** Parses untrusted input (e.g. a WebSocket message). Returns null if it isn't a valid event. */
export function parseStepEvent(input: unknown): StepEvent | null {
  const result = StepEventSchema.safeParse(input);
  return result.success ? result.data : null;
}
