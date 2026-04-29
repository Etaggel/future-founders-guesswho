import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

export class CertificateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const hostedZoneId = process.env.HOSTED_ZONE_ID;
    if (!hostedZoneId) {
      throw new Error("HOSTED_ZONE_ID is required for CertificateStack");
    }

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "LeggHostedZone", {
      zoneName: "legg.ie",
      hostedZoneId,
    });

    const certificate = new acm.Certificate(this, "FoundersCertificate", {
      domainName: "founders.legg.ie",
      validation: acm.CertificateValidation.fromDns(zone),
    });

    new cdk.CfnOutput(this, "CertificateArn", {
      value: certificate.certificateArn,
    });
  }
}
