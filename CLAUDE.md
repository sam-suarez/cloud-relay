# Cloud Relay

A visual, interactive demo of how AWS works end to end. A visitor uploads a photo; it is resized, moderated and tagged, and an architecture diagram animates in real time as the request moves through:

CloudFront → API Gateway (HTTP) → Lambda (presign) → S3 → SQS → worker Lambda (sharp) → Rekognition → DynamoDB → API Gateway WebSocket → browser

## Commands

```bash
npm run dev          # web app on localhost (mock event stream)
npm run lint         # ESLint (flat config at repo root)
npm run format       # Prettier
npm run typecheck    # tsc in every workspace (web runs react-router typegen first)
npm test             # Vitest in every workspace
npm run synth        # cdk synth (infra)
npm run check        # all of the above
```

`cdk diff` is `npm run diff -w @cloud-relay/infra`.

## Layout

- `apps/web`: React Router v8 SPA (`ssr: false`), Tailwind v4, React Flow (`@xyflow/react`), Motion
- `packages/shared`: zod schemas shared by the browser and Lambdas (the `StepEvent` contract)
- `services/*`: Lambda and container code (`api`, `workers`, `realtime`, `heavy`)
- `infra`: CDK v2 app. `StatefulStack` (buckets, tables, database, user pool) and `StatelessStack` (Lambdas, APIs, CloudFront, ECS)

Workspace packages export TypeScript source directly (`"exports": { ".": "./src/index.ts" }`); Vite, tsx and esbuild compile them. Relative imports use `.ts` extensions. TypeScript is pinned to 6.0.x until typescript-eslint supports 7.x.

## Rules

- **Deploys are run by a human.** Agents must not run `cdk deploy`/`destroy` or any command that creates, changes or deletes AWS resources; provide the command instead. `cdk synth`, `cdk diff` and read-only `describe`/`list`/`get` calls are fine.
- **Region is `us-east-2` only**, set in `infra/lib/config.ts`. Avoid ca-central-1: Rekognition doesn't support DetectLabels/DetectModerationLabels there.
- **The diagram is driven only by real backend events.** Every Lambda/task emits `StepEvent`s (`packages/shared/src/events.ts`). No client-side timers that fake progress. The mock stream (`apps/web/app/lib/mock-event-stream.ts`) is for local development only.
- **No account IDs, ARNs, domains or secrets in code or docs.** The account comes from credentials (`CDK_DEFAULT_ACCOUNT`); config comes from environment, CDK context or SSM Parameter Store. `cdk.context.json` is gitignored.
- **Keep costs near zero**: no NAT gateways, no always-on EC2, no provisioned databases. Aurora auto-pauses; Fargate runs only on demand in a public subnet with a public IP.
- **Least privilege**: one IAM role per Lambda/task with only the actions it needs (prefer CDK `grant*` methods). No long-lived access keys.
- **Public-demo guardrails**: upload size/type limits, API throttling, reserved concurrency on the worker, image auto-deletion (S3 lifecycle rules + DynamoDB TTL), moderation check, budget alarm.
- Readable code over clever code; short comments where an AWS concept isn't obvious.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `ci:`).
