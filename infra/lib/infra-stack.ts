import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'DocsBucket', {
      bucketName: `liteparse-docs-${cdk.Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          prefix: 'raw/',
          expiration: cdk.Duration.days(90),
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
        {
          prefix: 'processed/',
          expiration: cdk.Duration.days(90),
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
    });

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // S3 Gateway endpoint — free, avoids NAT data transfer charges
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    const service = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'ParseService', {
      cluster,
      cpu: 1024,
      memoryLimitMiB: 4096,
      desiredCount: 1,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry('ghcr.io/run-llama/liteparse-server:main'),
        containerPort: 5000,
        logDriver: ecs.LogDrivers.awsLogs({
          logGroup: new logs.LogGroup(this, 'ServiceLogs', {
            retention: logs.RetentionDays.TWO_WEEKS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
          streamPrefix: 'liteparse',
        }),
      },
      publicLoadBalancer: false,
      enableExecuteCommand: this.node.tryGetContext('enableExec') === 'true',
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
    });

    // LiteParse only exposes POST /parse and POST /screenshots — no GET endpoints.
    // GET / returns 404 from Express, which proves the HTTP server is up and accepting
    // connections. 5xx or timeouts indicate real failures.
    service.targetGroup.configureHealthCheck({
      path: '/',
      healthyHttpCodes: '200,404',
      interval: cdk.Duration.seconds(30),
    });

    service.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '10');

    bucket.grantReadWrite(service.taskDefinition.taskRole);

    // Auto-scaling
    const scaling = service.service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 4,
    });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
    });

    // CloudWatch Alarms
    new cloudwatch.Alarm(this, 'TargetGroup5xxAlarm', {
      metric: service.targetGroup.metrics.httpCodeTarget(
        elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
        { period: cdk.Duration.minutes(5) },
      ),
      threshold: 10,
      evaluationPeriods: 2,
      alarmDescription: 'High 5xx error rate from LiteParse tasks',
    });

    new cloudwatch.Alarm(this, 'CpuUtilizationAlarm', {
      metric: service.service.metricCpuUtilization({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 85,
      evaluationPeriods: 3,
      alarmDescription: 'Sustained high CPU on LiteParse service',
    });

    new cloudwatch.Alarm(this, 'UnhealthyHostAlarm', {
      metric: service.targetGroup.metrics.unhealthyHostCount({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      alarmDescription: 'Unhealthy targets in LiteParse target group',
    });

    // Lambda: S3 raw/ → parse via ECS → write to processed/
    const parseFunction = new nodejs.NodejsFunction(this, 'ParseFunction', {
      entry: path.join(__dirname, 'lambda', 'parse-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      environment: {
        SERVICE_URL: `http://${service.loadBalancer.loadBalancerDnsName}`,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Allow Lambda to reach the ALB
    service.loadBalancer.connections.allowFrom(
      parseFunction,
      ec2.Port.tcp(80),
      'Lambda parse function to ALB',
    );

    // Grant Lambda read/write to the bucket
    bucket.grantReadWrite(parseFunction);

    // Trigger Lambda on new objects in raw/ prefix
    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(parseFunction),
      { prefix: 'raw/' },
    );

    new cdk.CfnOutput(this, 'ServiceUrl', {
      value: `http://${service.loadBalancer.loadBalancerDnsName}`,
    });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'ParseFunctionName', { value: parseFunction.functionName });
    new cdk.CfnOutput(this, 'ParseFunctionArn', { value: parseFunction.functionArn });
  }
}
