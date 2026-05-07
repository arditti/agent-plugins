import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

export interface BaselineWafProps extends cdk.StackProps {
  // Scope CLOUDFRONT — attach to a distribution. For regional resources, set scope: 'REGIONAL'
  // and deploy this stack in the resource's region. CLOUDFRONT-scope ACLs MUST live in us-east-1.
  readonly scope?: 'CLOUDFRONT' | 'REGIONAL';
  // Optional — include SQLi rule group. Default true; flip off if the origin is fully parameterized + managed.
  readonly enableSqli?: boolean;
  // Optional regional ARNs to associate (ALB, API GW, AppSync, Cognito). Ignored when scope=CLOUDFRONT.
  readonly regionalResourceArns?: string[];
}

export class BaselineWafStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BaselineWafProps = {}) {
    super(scope, id, props);

    const aclScope = props.scope ?? 'CLOUDFRONT';
    const enableSqli = props.enableSqli ?? true;

    const rules: wafv2.CfnWebACL.RuleProperty[] = [
      {
        name: 'AWS-AmazonIpReputationList',
        priority: 10,
        // Start Count in tuning; this example promotes to active after validation.
        // overrideAction { none } means the rule group's own block actions apply.
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesAmazonIpReputationList',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: 'AmazonIpReputationList',
        },
      },
      {
        name: 'AWS-AnonymousIpList',
        priority: 20,
        // Still Count-mode — anonymizers (Tor/VPN) are load-bearing for legitimate users in many markets.
        // Promote only after you know the traffic shape for your app.
        overrideAction: { count: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesAnonymousIpList',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: 'AnonymousIpList',
        },
      },
      {
        name: 'AWS-KnownBadInputs',
        priority: 30,
        // KnownBadInputs is high-signal / low-FP — safe to run active from day one.
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesKnownBadInputsRuleSet',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: 'KnownBadInputs',
        },
      },
      {
        name: 'AWS-CommonRuleSet',
        priority: 40,
        // Count-first for CRS. CRS has real FP potential on SizeRestrictions_BODY and GenericRFI_BODY;
        // tune with ruleActionOverrides before going active.
        overrideAction: { count: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesCommonRuleSet',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: 'CommonRuleSet',
        },
      },
    ];

    if (enableSqli) {
      rules.push({
        name: 'AWS-SQLiRuleSet',
        priority: 50,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesSQLiRuleSet',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: 'SQLiRuleSet',
        },
      });
    }

    rules.push({
      name: 'RateLimitByIP',
      priority: 60,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          // Example Limit — always tune to your baseline P99 per IP. See the docs:
          // https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html
          limit: 2000,
          evaluationWindowSec: 300,
          aggregateKeyType: 'IP',
          // ScopeDown — only rate-limit the API surface. Static assets behind CDN are not worth rate-limiting by IP.
          scopeDownStatement: {
            byteMatchStatement: {
              searchString: '/api/',
              fieldToMatch: { uriPath: {} },
              positionalConstraint: 'STARTS_WITH',
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: 'RateLimitByIP',
      },
    });

    const webAcl = new wafv2.CfnWebACL(this, 'BaselineWebAcl', {
      scope: aclScope,
      defaultAction: { allow: {} },
      rules,
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: 'BaselineWebAcl',
      },
    });

    // Associate regional resources if provided. CLOUDFRONT-scope ACLs are attached via the distribution's webAclId instead.
    if (aclScope === 'REGIONAL' && props.regionalResourceArns?.length) {
      props.regionalResourceArns.forEach((arn, i) => {
        new wafv2.CfnWebACLAssociation(this, `Assoc${i}`, {
          resourceArn: arn,
          webAclArn: webAcl.attrArn,
        });
      });
    }

    new cdk.CfnOutput(this, 'WebAclArn', { value: webAcl.attrArn });
    new cdk.CfnOutput(this, 'WebAclId', { value: webAcl.attrId });
  }
}
