import { CfnOutput, Duration } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/** Custom metric namespace for numbers our own logs produce. */
const METRIC_NAMESPACE = 'CloudRelay';

/** The account-wide monthly budget, in USD. The spend limit ($20) is the hard stop. */
const MONTHLY_BUDGET_USD = 5;

export interface MonitoringProps {
  /**
   * Where alarms and budget alerts go. From CDK context or the environment,
   * never from code. Without it (tests, CI synth) nothing subscribes and the
   * budget is skipped.
   */
  alertEmail?: string;
  presignFunction: lambda.IFunction;
  workerFunction: lambda.IFunction;
  workerLogGroup: logs.ILogGroup;
  uploadsQueue: sqs.IQueue;
  deadLetterQueue: sqs.IQueue;
}

/**
 * Alarms, alerts and a dashboard for the pipeline:
 * - an SNS topic that emails `alertEmail`
 * - alarms when the DLQ holds messages or the worker fails unexpectedly
 * - a $5/month AWS Budgets alert (actual and forecasted)
 * - one CloudWatch dashboard
 */
export class Monitoring extends Construct {
  readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);

    // SNS → Topics → Create topic, then a subscription per email address. AWS
    // emails a confirmation link first; nothing arrives until it is clicked.
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'Cloud Relay alarms',
    });
    if (props.alertEmail) {
      this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));
    }
    const notify = new actions.SnsAction(this.alarmTopic);

    // A message in the DLQ means an upload failed WORKER_MAX_ATTEMPTS times.
    // The alarm stays in ALARM (and doesn't email again) until the DLQ is empty:
    // redriven, purged, or expired after its 4-day retention.
    const dlqDepth = props.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
      period: Duration.minutes(1),
      statistic: cloudwatch.Stats.MAXIMUM,
    });
    const dlqAlarm = dlqDepth.createAlarm(this, 'DeadLetterQueueAlarm', {
      alarmDescription: 'An upload failed every attempt and is waiting in the dead-letter queue.',
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      // An idle queue may stop reporting; no data means nothing is waiting.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(notify);

    // The worker reports failed messages back to SQS instead of throwing
    // (partial batch response), so Lambda's Errors metric only counts crashes,
    // timeouts and out-of-memory. A metric filter turns each "Attempt failed"
    // log line into a data point, leaving out the visitor-facing "Simulate
    // failure" checkbox so the demo doesn't email on purpose-made failures.
    // Metric filters are free; the metric counts as one custom metric.
    const failedAttemptsFilter = new logs.MetricFilter(this, 'FailedAttemptsFilter', {
      logGroup: props.workerLogGroup,
      filterPattern: logs.FilterPattern.literal('"Attempt failed" -"Simulated failure"'),
      metricNamespace: METRIC_NAMESPACE,
      metricName: 'WorkerFailedAttempts',
      metricValue: '1',
    });
    const failedAttempts = failedAttemptsFilter.metric({
      period: Duration.minutes(5),
      statistic: cloudwatch.Stats.SUM,
      label: 'Failed attempts',
    });
    const workerErrors = props.workerFunction.metricErrors({
      period: Duration.minutes(5),
      label: 'Errors (crash, timeout)',
    });

    // Metric math: no data points means 0, so either source alone can trip it.
    const workerFailures = new cloudwatch.MathExpression({
      expression: 'FILL(errors, 0) + FILL(failed, 0)',
      usingMetrics: { errors: workerErrors, failed: failedAttempts },
      period: Duration.minutes(5),
      label: 'Worker failures',
    });
    const workerAlarm = workerFailures.createAlarm(this, 'WorkerFailuresAlarm', {
      alarmDescription:
        'The image worker failed an attempt (Rekognition, S3, DynamoDB, a crash or a timeout).',
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    workerAlarm.addAlarmAction(notify);

    // Billing → Budgets. A budget only alerts; the project's spend limit is what
    // actually stops spending. Budgets is a global service (its API lives in
    // us-east-1), but CloudFormation can create one from any Region.
    if (props.alertEmail) {
      const subscribers = [{ subscriptionType: 'EMAIL', address: props.alertEmail }];
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: 'cloud-relay-monthly',
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: MONTHLY_BUDGET_USD, unit: 'USD' },
        },
        notificationsWithSubscribers: [
          {
            notification: {
              notificationType: 'ACTUAL',
              comparisonOperator: 'GREATER_THAN',
              threshold: 100,
              thresholdType: 'PERCENTAGE',
            },
            subscribers,
          },
          {
            // Forecasts need about 5 weeks of billing history before they fire.
            notification: {
              notificationType: 'FORECASTED',
              comparisonOperator: 'GREATER_THAN',
              threshold: 100,
              thresholdType: 'PERCENTAGE',
            },
            subscribers,
          },
        ],
      });
    }

    const queueMetric = (metric: cloudwatch.Metric) => metric.with({ period: Duration.minutes(5) });
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'cloud-relay',
      defaultInterval: Duration.days(1),
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Uploads',
        left: [
          props.presignFunction.metricInvocations({ label: 'Upload URLs issued' }),
          // One S3 notification per object that actually arrived.
          queueMetric(props.uploadsQueue.metricNumberOfMessagesSent({ label: 'Uploads received' })),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Worker duration (ms)',
        left: [
          props.workerFunction.metricDuration({
            statistic: cloudwatch.Stats.AVERAGE,
            label: 'Average',
          }),
          props.workerFunction.metricDuration({ statistic: cloudwatch.Stats.p(95), label: 'p95' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Worker invocations and failures',
        left: [
          props.workerFunction.metricInvocations({ label: 'Invocations' }),
          workerErrors,
          failedAttempts,
        ],
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Uploads queue depth',
        left: [
          queueMetric(
            props.uploadsQueue.metricApproximateNumberOfMessagesVisible({ label: 'Waiting' }),
          ),
          queueMetric(
            props.uploadsQueue.metricApproximateNumberOfMessagesNotVisible({ label: 'In flight' }),
          ),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Oldest message age (s)',
        left: [
          queueMetric(
            props.uploadsQueue.metricApproximateAgeOfOldestMessage({ label: 'Uploads queue' }),
          ),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Dead-letter queue depth',
        left: [dlqDepth.with({ label: 'Messages' })],
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'Alarms',
        alarms: [dlqAlarm, workerAlarm],
        width: 24,
        height: 3,
      }),
    );

    new CfnOutput(this, 'DeadLetterQueueAlarmName', { value: dlqAlarm.alarmName });
    new CfnOutput(this, 'WorkerFailuresAlarmName', { value: workerAlarm.alarmName });
  }
}
