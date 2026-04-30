import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

export class FfGameStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const domainName = "founders.legg.ie";
    const hostedZoneId = process.env.HOSTED_ZONE_ID;
    const zone = hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, "LeggHostedZone", {
          zoneName: "legg.ie",
          hostedZoneId,
        })
      : undefined;
    const certificateArn = process.env.CERTIFICATE_ARN;

    const progressTable = new dynamodb.Table(this, "ProgressTable", {
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gameKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const pairInsightsTable = new dynamodb.Table(this, "PairInsightsTable", {
      partitionKey: { name: "pairKey", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "inputSignature", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
    });

    const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool,
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [`https://${domainName}/auth/callback`, "http://localhost:3000/auth/callback"],
        logoutUrls: [`https://${domainName}`, "http://localhost:3000"],
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
        cognito.UserPoolClientIdentityProvider.GOOGLE,
      ],
    });

    const googleOAuthSecret = new secretsmanager.Secret(this, "GoogleOAuthSecret", {
      secretName: "ff-game/google-oauth",
      description: "Google OAuth credentials for the Future Founders Cognito provider.",
      secretObjectValue: {
        clientId: cdk.SecretValue.unsafePlainText("replace-with-google-client-id"),
        clientSecret: cdk.SecretValue.unsafePlainText("replace-with-google-client-secret"),
      },
    });

    const googleProvider = new cognito.CfnUserPoolIdentityProvider(this, "GoogleIdP", {
      userPoolId: userPool.userPoolId,
      providerName: "Google",
      providerType: "Google",
      providerDetails: {
        client_id: googleOAuthSecret.secretValueFromJson("clientId").unsafeUnwrap(),
        client_secret: googleOAuthSecret.secretValueFromJson("clientSecret").unsafeUnwrap(),
        authorize_scopes: "openid email profile",
      },
      attributeMapping: {
        email: "email",
        given_name: "given_name",
        family_name: "family_name",
      },
    });
    userPoolClient.node.addDependency(googleProvider);

    const cognitoDomain = userPool.addDomain("UserPoolDomain", {
      cognitoDomain: {
        domainPrefix: `ffgame-${this.account}`,
      },
    });

    const apiLambda = new lambda.Function(this, "GameApiLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, "../../lambda")),
      handler: "index.handler",
      timeout: cdk.Duration.seconds(15),
      environment: {
        PROGRESS_TABLE_NAME: progressTable.tableName,
        PAIR_INSIGHTS_TABLE_NAME: pairInsightsTable.tableName,
      },
    });
    progressTable.grantReadWriteData(apiLambda);
    pairInsightsTable.grantReadWriteData(apiLambda);
    apiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:bedrock:${cdk.Aws.REGION}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
          `arn:${cdk.Aws.PARTITION}:bedrock:${cdk.Aws.REGION}::foundation-model/amazon.nova-lite-v1:0`,
        ],
      }),
    );

    const httpApi = new apigw.HttpApi(this, "GameHttpApi", {
      corsPreflight: {
        allowHeaders: ["authorization", "content-type"],
        allowMethods: [apigw.CorsHttpMethod.ANY],
        allowOrigins: [`https://${domainName}`],
      },
      defaultAuthorizer: new authorizers.HttpUserPoolAuthorizer(
        "UserPoolAuthorizer",
        userPool,
        { userPoolClients: [userPoolClient] },
      ),
    });

    httpApi.addRoutes({
      path: "/progress",
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("GameApiIntegration", apiLambda),
    });

    httpApi.addRoutes({
      path: "/ai/{proxy+}",
      methods: [apigw.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("AiApiIntegration", apiLambda),
    });

    const bucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    const cert = certificateArn
      ? acm.Certificate.fromCertificateArn(this, "SiteCertificate", certificateArn)
      : undefined;

    const staticExportRewrite = new cloudfront.Function(this, "StaticExportRewrite", {
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (!uri.includes('.')) {
    request.uri = uri + '.html';
  }
  return request;
}`),
    });

    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: staticExportRewrite,
          },
        ],
      },
      domainNames: cert ? [domainName] : undefined,
      certificate: cert,
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
        },
      ],
    });

    new s3deploy.BucketDeployment(this, "DeployWeb", {
      destinationBucket: bucket,
      distribution,
      distributionPaths: ["/*"],
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "../../web/out")),
        s3deploy.Source.jsonData("runtime-config.json", {
          apiBaseUrl: httpApi.url ?? "",
          cognitoDomain: cognitoDomain.baseUrl(),
          userPoolId: userPool.userPoolId,
          userPoolClientId: userPoolClient.userPoolClientId,
          oauthCallbackUrl: `https://${domainName}/auth/callback`,
          oauthLogoutUrl: `https://${domainName}`,
        }),
      ],
    });

    if (zone) {
      new route53.ARecord(this, "SiteAlias", {
        zone,
        recordName: "founders",
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      });
    }

    new cdk.CfnOutput(this, "CloudFrontUrl", {
      value: `https://${domainName}`,
    });
    new cdk.CfnOutput(this, "ApiBaseUrl", { value: httpApi.url ?? "" });
    new cdk.CfnOutput(this, "CognitoDomain", { value: cognitoDomain.baseUrl() });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "GoogleOAuthSecretArn", { value: googleOAuthSecret.secretArn });
  }
}
