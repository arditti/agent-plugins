import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

export interface BotControlWafProps extends cdk.StackProps {
  // Token domains MUST include all domains where the JS SDK runs.
  // Include apex + every CloudFront alternate domain + every mobile-app domain that posts the token back.
  readonly tokenDomains: string[];
  // Default CLOUDFRONT. CLOUDFRONT-scope ACLs live in us-east-1.
  readonly scope?: 'CLOUDFRONT' | 'REGIONAL';
  // ATP on /login is optional — only enable if you can tolerate response-body inspection latency + cost.
  readonly enableAtp?: boolean;
  // Regional resource ARNs (only used when scope=REGIONAL).
  readonly regionalResourceArns?: string[];
}

export class BotControlWafStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BotControlWafProps) {
    super(scope, id, props);
    if (!props.tokenDomains?.length) {
      throw new Error('BotControlWafProps.tokenDomains is required and must be non-empty.');
    }
    const aclScope = props.scope ?? 'CLOUDFRONT';

    const rules: wafv2.CfnWebACL.RuleProperty[] = [
      {
        name: 'AWS-BotControl-Targeted',
        priority: 10,
        // Count-first. Targeted uses behavioral signals and challenge-based evaluation; FP surface is real
        // until you've validated the shape of legitimate traffic.
        overrideAction: { count: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesBotControlRuleSet',
            managedRuleGroupConfigs: [
              {
                // Targeted level — behavioral signals for high-value flows; scope-down to checkout/login in production.
                awsManagedRulesBotControlRuleSet: { inspectionLevel: 'TARGETED' },
              },
            ],
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: 'BotControlTargeted',
        },
      },
      {
        name: 'RateLimit-JA4',
        priority: 20,
        // Challenge over CAPTCHA — invisible JS proof-of-browser; CAPTCHA is for last-resort human gates.
        action: { challenge: {} },
        statement: {
          rateBasedStatement: {
            // JA4 aggregation catches distributed scrapers that rotate IPs but keep the same TLS fingerprint.
            // Example Limit — tune to your JA4 distribution. See:
            // https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html
            limit: 1000,
            evaluationWindowSec: 300,
            aggregateKeyType: 'CUSTOM_KEYS',
            customKeys: [
              { ja4Fingerprint: { fallbackBehavior: 'NO_MATCH' } },
            ],
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: 'RateLimitJA4',
        },
      },
      {
        name: 'ChallengeNonBrowserUnlessVerified',
        priority: 30,
        action: { challenge: {} },
        // Challenge requests labeled non_browser_user_agent UNLESS they are also labeled verified_bot.
        statement: {
          andStatement: {
            statements: [
              {
                labelMatchStatement: {
                  scope: 'LABEL',
                  key: 'awswaf:managed:aws:bot-control:signal:non_browser_user_agent',
                },
              },
              {
                notStatement: {
                  statement: {
                    labelMatchStatement: {
                      scope: 'LABEL',
                      key: 'awswaf:managed:aws:bot-control:signal:verified_bot',
                    },
                  },
                },
              },
            ],
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: 'ChallengeNonBrowser',
        },
      },
    ];

    if (props.enableAtp) {
      rules.push({
        name: 'AWS-ATP-Login',
        priority: 40,
        // ATP ships with its own default actions per sub-rule; keep { none } and tune with ruleActionOverrides if needed.
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesATPRuleSet',
            managedRuleGroupConfigs: [
              {
                awsManagedRulesAtpRuleSet: {
                  loginPath: '/login',
                  requestInspection: {
                    payloadType: 'JSON',
                    usernameField: { identifier: '/username' },
                    passwordField: { identifier: '/password' },
                  },
                  responseInspection: {
                    statusCode: { successCodes: [200], failureCodes: [401, 403] },
                  },
                },
              },
            ],
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: 'AtpLogin',
        },
      });
    }

    const webAcl = new wafv2.CfnWebACL(this, 'BotControlWebAcl', {
      scope: aclScope,
      defaultAction: { allow: {} },
      // tokenDomains applies to the Challenge/CAPTCHA tokens issued by this ACL.
      // MUST include apex + all CloudFront alternate domains + mobile app domains.
      tokenDomains: props.tokenDomains,
      rules,
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: 'BotControlWebAcl',
      },
    });

    if (aclScope === 'REGIONAL' && props.regionalResourceArns?.length) {
      props.regionalResourceArns.forEach((arn, i) => {
        new wafv2.CfnWebACLAssociation(this, `Assoc${i}`, {
          resourceArn: arn,
          webAclArn: webAcl.attrArn,
        });
      });
    }

    new cdk.CfnOutput(this, 'WebAclArn', { value: webAcl.attrArn });
  }
}
