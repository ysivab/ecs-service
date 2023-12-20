"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EcsService = void 0;
const cdk = require("aws-cdk-lib");
const constructs_1 = require("constructs");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_cdk_lib_2 = require("aws-cdk-lib");
const aws_cdk_lib_3 = require("aws-cdk-lib");
const aws_cdk_lib_4 = require("aws-cdk-lib");
const elb = require("aws-cdk-lib/aws-elasticloadbalancingv2");
class EcsService extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const appName = props.appName;
        const services = props.services;
        const vpcId = aws_cdk_lib_2.aws_ssm.StringParameter.fromStringParameterAttributes(this, 'vpcid', {
            parameterName: `/network/vpc_id`
        }).stringValue;
        const az1 = aws_cdk_lib_2.aws_ssm.StringParameter.fromStringParameterAttributes(this, 'az1', {
            parameterName: `/network/az1`
        }).stringValue;
        const az2 = aws_cdk_lib_2.aws_ssm.StringParameter.fromStringParameterAttributes(this, 'az2', {
            parameterName: `/network/az2`
        }).stringValue;
        const pubsub1 = aws_cdk_lib_2.aws_ssm.StringParameter.fromStringParameterAttributes(this, 'pubsub1', {
            parameterName: `/network/pubsub1`
        }).stringValue;
        const pubsub2 = aws_cdk_lib_2.aws_ssm.StringParameter.fromStringParameterAttributes(this, 'pubsub2', {
            parameterName: `/network/pubsub2`
        }).stringValue;
        const prisub1 = aws_cdk_lib_2.aws_ssm.StringParameter.fromStringParameterAttributes(this, 'prisub1', {
            parameterName: `/network/prisub1`
        }).stringValue;
        const prisub2 = aws_cdk_lib_2.aws_ssm.StringParameter.fromStringParameterAttributes(this, 'prisub2', {
            parameterName: `/network/prisub2`
        }).stringValue;
        const vpc = aws_cdk_lib_4.aws_ec2.Vpc.fromVpcAttributes(this, "VPC", {
            vpcId: vpcId,
            availabilityZones: [
                az1,
                az2
            ],
            publicSubnetIds: [
                pubsub1,
                pubsub2
            ],
            privateSubnetIds: [
                prisub1,
                prisub2
            ]
        });
        const clusterArn = aws_cdk_lib_2.aws_ssm.StringParameter.fromStringParameterAttributes(this, 'clusterArn', {
            parameterName: `/ecs/clusterarn`
        }).stringValue;
        const SecurityGroupEcsFargate = new aws_cdk_lib_4.aws_ec2.SecurityGroup(this, 'SecurityGroupEcsFargate', {
            vpc: vpc,
            allowAllOutbound: true,
            description: 'Security Group for Fargate'
        });
        const cluster = aws_cdk_lib_3.aws_ecs.Cluster.fromClusterAttributes(this, 'ecs-cluster', {
            clusterArn: clusterArn,
            clusterName: `cluster-${appName}`,
            vpc: vpc,
            securityGroups: [SecurityGroupEcsFargate]
        });
        const taskRole = new aws_cdk_lib_1.aws_iam.Role(this, `ecs-taskRole-${appName}`, {
            roleName: `role-${appName}EcsTaskRole`,
            assumedBy: new aws_cdk_lib_1.aws_iam.ServicePrincipal('ecs-tasks.amazonaws.com')
        });
        taskRole.addToPolicy(new aws_cdk_lib_1.aws_iam.PolicyStatement({
            resources: ['*'],
            actions: [
                "ssm:*",
                "s3:*"
            ],
        }));
        /* Setup ALB, attach Port 443, 80 and blue/green target groups */
        const alb = new elb.ApplicationLoadBalancer(this, 'alb', {
            loadBalancerName: `alb-${appName}`,
            vpc: vpc,
            internetFacing: true
        });
        const albProdListener = alb.addListener('albProdListener', {
            port: 80,
        });
        // albProdListener.addTargets(`blue-defaultaction-${e.serviceName}`, {
        //   port: 80,
        //   targets: [service]
        // })
        albProdListener.addAction('fixed', {
            action: elb.ListenerAction.fixedResponse(503, {
                messageBody: 'OK'
            })
            // action: alb.ListenerAction.fixedResponse(200, {
            //   contentType: elbv2.ContentType.TEXT_PLAIN,
            //   messageBody: 'OK',
            // })
        });
        /* Creating ECS service, roles, taskdef etc */
        const executionRolePolicy = new aws_cdk_lib_1.aws_iam.PolicyStatement({
            effect: aws_cdk_lib_1.aws_iam.Effect.ALLOW,
            resources: ['*'],
            actions: [
                "ecr:GetAuthorizationToken",
                "ecr:BatchCheckLayerAvailability",
                "ecr:GetDownloadUrlForLayer",
                "ecr:BatchGetImage",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "ssm:*"
            ]
        });
        const logging = new aws_cdk_lib_3.aws_ecs.AwsLogDriver({
            streamPrefix: `logs-${appName}`
        });
        services.map((e, index) => {
            const blueTargetGroup = new elb.ApplicationTargetGroup(this, `blueGroup-${e.serviceName}`, {
                vpc: vpc,
                targetGroupName: `TG-${e.serviceName}`,
                protocol: elb.ApplicationProtocol.HTTP,
                port: 80,
                targetType: elb.TargetType.IP,
                healthCheck: {
                    path: e.path ? e.path : '/',
                    timeout: cdk.Duration.seconds(30),
                    interval: cdk.Duration.seconds(60),
                    healthyHttpCodes: '200-499'
                }
            });
            albProdListener.addTargetGroups(`blueTarget-${e.serviceName}`, {
                conditions: (e.hostName && !e.path) ? [
                    elb.ListenerCondition.hostHeaders([e.hostName]),
                ] : (e.hostName && e.path) ? [elb.ListenerCondition.hostHeaders([e.hostName]), elb.ListenerCondition.pathPatterns([e.path])] : undefined,
                priority: (index + 1),
                targetGroups: [blueTargetGroup]
            });
            const taskDef = new aws_cdk_lib_3.aws_ecs.FargateTaskDefinition(this, `ecs-taskdef-${e.serviceName}`, {
                taskRole: taskRole,
                family: `${e.serviceName}`
            });
            taskDef.addToExecutionRolePolicy(executionRolePolicy);
            // const initContainerRepo = ecr.Repository.fromRepositoryName(this, 'Repo', "init-container");
            const container = taskDef.addContainer(`${e.serviceName}`, {
                image: aws_cdk_lib_3.aws_ecs.ContainerImage.fromRegistry(e.imageUri),
                memoryLimitMiB: 256,
                cpu: 256,
                logging
            });
            container.addPortMappings({
                containerPort: e.containerPort,
                protocol: aws_cdk_lib_3.aws_ecs.Protocol.TCP
            });
            const service = new aws_cdk_lib_3.aws_ecs.FargateService(this, `FargateService-${e.serviceName}`, {
                cluster,
                taskDefinition: taskDef,
                serviceName: `ecs-${e.serviceName}`,
                healthCheckGracePeriod: cdk.Duration.seconds(60),
                desiredCount: e.desiredCount,
                deploymentController: {
                    type: aws_cdk_lib_3.aws_ecs.DeploymentControllerType.ECS
                },
            });
            service.connections.allowFrom(alb, aws_cdk_lib_4.aws_ec2.Port.tcp(80));
            service.connections.allowFrom(alb, aws_cdk_lib_4.aws_ec2.Port.tcp(8080));
            service.attachToApplicationTargetGroup(blueTargetGroup);
        });
    }
}
exports.EcsService = EcsService;
