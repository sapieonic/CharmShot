import * as path from 'node:path';
import {
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_apigatewayv2 as apigwv2,
  aws_apigatewayv2_integrations as integrations,
  aws_cloudwatch as cloudwatch,
  aws_lambda as lambda,
  aws_lambda_event_sources as eventsources,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * CharmShot backend stack.
 *
 * Provisions: two private encrypted S3 buckets (uploads/results), an SQS queue
 * + DLQ, the API Lambda fronted by an HTTP API, the SQS worker Lambda, Secrets
 * Manager secrets, and least-privilege IAM wiring. CloudWatch alarms surface
 * job failures and DLQ depth.
 */
export class CharmShotStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---- Secrets ---------------------------------------------------------
    // These are created empty; populate values out-of-band (console / CLI).
    const mongoSecret = new secretsmanager.Secret(this, 'MongoSecret', {
      secretName: 'charmshot/mongodb',
      description: 'MongoDB connection string: { "uri": "mongodb+srv://..." }',
    });
    const firebaseSecret = new secretsmanager.Secret(this, 'FirebaseSecret', {
      secretName: 'charmshot/firebase-service-account',
      description: 'Firebase service account JSON',
    });
    const revenueCatSecret = new secretsmanager.Secret(this, 'RevenueCatSecret', {
      secretName: 'charmshot/revenuecat',
      description: 'RevenueCat webhook auth: { "authHeader": "..." }',
    });
    const providerSecret = new secretsmanager.Secret(this, 'ProviderSecret', {
      secretName: 'charmshot/providers',
      description: 'Model provider API keys: { "nanoBananaApiKey": "..." }',
    });

    // ---- S3 buckets (private, encrypted, TLS-only) -----------------------
    const commonBucketProps: Partial<s3.BucketProps> = {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: false,
    };

    const uploadsBucket = new s3.Bucket(this, 'UploadsBucket', {
      ...commonBucketProps,
      // Presigned PUT from browsers needs CORS.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        // Retention: purge raw reference uploads after 30 days.
        { expiration: Duration.days(30) },
      ],
    });

    const resultsBucket = new s3.Bucket(this, 'ResultsBucket', {
      ...commonBucketProps,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        // Retention: generated results expire after 90 days.
        { expiration: Duration.days(90) },
      ],
    });

    // ---- SQS queue + DLQ -------------------------------------------------
    const deadLetterQueue = new sqs.Queue(this, 'GenerationDLQ', {
      queueName: 'charmshot-generation-dlq',
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    const generationQueue = new sqs.Queue(this, 'GenerationQueue', {
      queueName: 'charmshot-generation',
      visibilityTimeout: Duration.seconds(180), // > worker timeout
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 3 },
    });

    // ---- Shared Lambda config -------------------------------------------
    const entryRoot = path.join(__dirname, '..', '..', 'src');
    const sharedEnv: Record<string, string> = {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      MONGODB_DB_NAME: 'charmshot',
      MONGODB_SECRET_ARN: mongoSecret.secretArn,
      FIREBASE_SERVICE_ACCOUNT_SECRET_ARN: firebaseSecret.secretArn,
      REVENUECAT_SECRET_ARN: revenueCatSecret.secretArn,
      PROVIDER_SECRETS_ARN: providerSecret.secretArn,
      UPLOADS_BUCKET: uploadsBucket.bucketName,
      RESULTS_BUCKET: resultsBucket.bucketName,
      GENERATION_QUEUE_URL: generationQueue.queueUrl,
      DEFAULT_MODEL_ID: 'nano-banana',
      METRICS_NAMESPACE: 'CharmShot',
      METRICS_ENABLED: 'true',
      FREE_TIER_CREDITS: '10',
      REFUND_ON_FAILURE: 'true',
    };

    const bundling: nodejs.BundlingOptions = {
      target: 'node22',
      minify: true,
      sourceMap: true,
      externalModules: ['@aws-sdk/*'], // provided by the Lambda runtime
    };

    // ---- API Lambda ------------------------------------------------------
    const apiFn = new nodejs.NodejsFunction(this, 'ApiFunction', {
      functionName: 'charmshot-api',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(entryRoot, 'api', 'lambda.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: Duration.seconds(29), // API Gateway max integration timeout
      environment: sharedEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling,
    });

    // ---- Worker Lambda ---------------------------------------------------
    const workerFn = new nodejs.NodejsFunction(this, 'WorkerFunction', {
      functionName: 'charmshot-worker',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(entryRoot, 'worker', 'lambda.ts'),
      handler: 'handler',
      memorySize: 1024,
      timeout: Duration.seconds(120),
      environment: sharedEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling,
    });

    workerFn.addEventSource(
      new eventsources.SqsEventSource(generationQueue, {
        batchSize: 5,
        reportBatchItemFailures: true,
        maxConcurrency: 10,
      }),
    );

    // ---- IAM least privilege --------------------------------------------
    // API: read secrets it needs, presign (read/write) on buckets, enqueue.
    mongoSecret.grantRead(apiFn);
    firebaseSecret.grantRead(apiFn);
    revenueCatSecret.grantRead(apiFn);
    uploadsBucket.grantPut(apiFn); // for presigned PUT signing
    uploadsBucket.grantRead(apiFn);
    resultsBucket.grantRead(apiFn); // for presigned GET signing
    generationQueue.grantSendMessages(apiFn);

    // Worker: read references, write results, read secrets, consume queue.
    mongoSecret.grantRead(workerFn);
    providerSecret.grantRead(workerFn);
    uploadsBucket.grantRead(workerFn);
    resultsBucket.grantPut(workerFn);
    generationQueue.grantConsumeMessages(workerFn);

    // ---- HTTP API --------------------------------------------------------
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'charmshot-api',
      createDefaultStage: true,
      corsPreflight: {
        allowHeaders: ['authorization', 'content-type'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'],
      },
    });

    const apiIntegration = new integrations.HttpLambdaIntegration('ApiIntegration', apiFn);

    const routes: { path: string; method: apigwv2.HttpMethod }[] = [
      { path: '/v1/uploads/presign', method: apigwv2.HttpMethod.POST },
      { path: '/v1/generations', method: apigwv2.HttpMethod.POST },
      { path: '/v1/generations/{jobId}', method: apigwv2.HttpMethod.GET },
      { path: '/v1/presets', method: apigwv2.HttpMethod.GET },
      { path: '/v1/me/entitlements', method: apigwv2.HttpMethod.GET },
      { path: '/v1/webhooks/revenuecat', method: apigwv2.HttpMethod.POST },
      { path: '/health', method: apigwv2.HttpMethod.GET },
    ];
    for (const route of routes) {
      httpApi.addRoutes({ path: route.path, methods: [route.method], integration: apiIntegration });
    }

    // ---- CloudWatch alarms ----------------------------------------------
    const jobsFailedMetric = new cloudwatch.Metric({
      namespace: 'CharmShot',
      metricName: 'jobs_failed',
      statistic: 'Sum',
      period: Duration.minutes(5),
    });
    new cloudwatch.Alarm(this, 'JobsFailedAlarm', {
      metric: jobsFailedMetric,
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'High number of failed generation jobs',
    });

    new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Messages present in the generation DLQ',
    });

    // ---- Outputs ---------------------------------------------------------
    this.exportValue(httpApi.apiEndpoint, { name: 'CharmShotApiEndpoint' });
    this.exportValue(uploadsBucket.bucketName, { name: 'CharmShotUploadsBucket' });
    this.exportValue(resultsBucket.bucketName, { name: 'CharmShotResultsBucket' });
    this.exportValue(generationQueue.queueUrl, { name: 'CharmShotGenerationQueueUrl' });
  }
}
