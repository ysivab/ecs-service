import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { aws_iam as iam } from 'aws-cdk-lib';
import { aws_ssm as ssm } from 'aws-cdk-lib';
import { aws_ecs as ecs } from 'aws-cdk-lib';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import * as elb from "aws-cdk-lib/aws-elasticloadbalancingv2";

export interface EcsServiceStackProps {
  appName: string;
  services: any;
}

export class EcsService extends Construct {
  constructor(scope: Construct, id: string, props: EcsServiceStackProps) {
    super(scope, id);

    const appName = props.appName;
    const services = props.services;

    const vpcId = ssm.StringParameter.fromStringParameterAttributes(this, 'vpcid', {
      parameterName: `/network/vpc_id`
    }).stringValue;

    const az1 = ssm.StringParameter.fromStringParameterAttributes(this, 'az1', {
      parameterName: `/network/az1`
    }).stringValue;

    const az2 = ssm.StringParameter.fromStringParameterAttributes(this, 'az2', {
      parameterName: `/network/az2`
    }).stringValue;

    const pubsub1 = ssm.StringParameter.fromStringParameterAttributes(this, 'pubsub1', {
      parameterName: `/network/pubsub1`
    }).stringValue;

    const pubsub2 = ssm.StringParameter.fromStringParameterAttributes(this, 'pubsub2', {
      parameterName: `/network/pubsub2`
    }).stringValue;

    const prisub1 = ssm.StringParameter.fromStringParameterAttributes(this, 'prisub1', {
      parameterName: `/network/prisub1`
    }).stringValue;

    const prisub2 = ssm.StringParameter.fromStringParameterAttributes(this, 'prisub2', {
      parameterName: `/network/prisub2`
    }).stringValue;

    const vpc = ec2.Vpc.fromVpcAttributes(this, "VPC", {
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
    
    const clusterArn = ssm.StringParameter.fromStringParameterAttributes(this, 'clusterArn', {
      parameterName: `/ecs/clusterarn`
    }).stringValue;

    const SecurityGroupEcsFargate = new ec2.SecurityGroup(this, 'SecurityGroupEcsFargate', {
      vpc: vpc,
      allowAllOutbound: true,
      description: 'Security Group for Fargate'
    });


    const cluster = ecs.Cluster.fromClusterAttributes(this, 'ecs-cluster', {
      clusterArn: clusterArn,
      clusterName: `cluster-${appName}`,
      vpc: vpc,
      securityGroups: [ SecurityGroupEcsFargate ]
    });

    const taskRole = new iam.Role(this, `ecs-taskRole-${appName}`, {
      roleName: `role-${appName}EcsTaskRole`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    })
    taskRole.addToPolicy(
      new iam.PolicyStatement(
        {
          resources: ['*'],
          actions: [
            "ssm:*",
            "s3:*"
          ],
        }
      )
    );
    
    

    /* Setup ALB, attach Port 443, 80 and blue/green target groups */
    const alb = new elb.ApplicationLoadBalancer(this, 'alb', {
      loadBalancerName: `alb-${appName}`,
      vpc: vpc!,
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
    })

    /* Creating ECS service, roles, taskdef etc */
    const executionRolePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
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

    const logging = new ecs.AwsLogDriver({
      streamPrefix: `logs-${appName}`
    });

    (services as [any]).map((e, index) => {
      const blueTargetGroup = new elb.ApplicationTargetGroup(this, `blueGroup-${e.serviceName}`, {
        vpc: vpc!,
        targetGroupName: `TG-${e.serviceName}`,
        protocol: elb.ApplicationProtocol.HTTP,
        port: 80,
        targetType: elb.TargetType.IP,
        healthCheck: {
          path: e.path? e.path : '/',
          timeout: cdk.Duration.seconds(30),
          interval: cdk.Duration.seconds(60),
          healthyHttpCodes: '200-499'
        }
      });

      albProdListener.addTargetGroups(`blueTarget-${e.serviceName}`, {
        conditions: (e.hostName && !e.path) ? [
          elb.ListenerCondition.hostHeaders([ e.hostName ]),
        ] : (e.hostName && e.path) ? [ elb.ListenerCondition.hostHeaders([ e.hostName ]), elb.ListenerCondition.pathPatterns([ e.path ]) ] : undefined,
        priority: (index+1),
        targetGroups: [blueTargetGroup]
      });

      const taskDef = new ecs.FargateTaskDefinition(this, `ecs-taskdef-${e.serviceName}`, {
        taskRole: taskRole,
        family: `${e.serviceName}`
      });
  
      taskDef.addToExecutionRolePolicy(executionRolePolicy);
  
      // const initContainerRepo = ecr.Repository.fromRepositoryName(this, 'Repo', "init-container");
      const container = taskDef.addContainer(`${e.serviceName}`, {
        image: ecs.ContainerImage.fromRegistry(e.imageUri), //ecs.ContainerImage.fromEcrRepository(initContainerRepo), // fromRegistry("amazon/amazon-ecs-sample"),
        memoryLimitMiB: 256,
        cpu: 256,
        logging
      });
  
      container.addPortMappings({
        containerPort: e.containerPort,
        protocol: ecs.Protocol.TCP
      });
  
      const service = new ecs.FargateService(this, `FargateService-${e.serviceName}`, {
        cluster,
        taskDefinition: taskDef,
        serviceName: `ecs-${e.serviceName}`,
        healthCheckGracePeriod: cdk.Duration.seconds(60),
        desiredCount: e.desiredCount,
        deploymentController: {
          type: ecs.DeploymentControllerType.ECS
        },
      });

      service.connections.allowFrom(alb, ec2.Port.tcp(80))
      service.connections.allowFrom(alb, ec2.Port.tcp(8080))
      service.attachToApplicationTargetGroup(blueTargetGroup);
    });
  }
}