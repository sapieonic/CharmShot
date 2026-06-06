#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CharmShotStack } from '../lib/charmshot-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

new CharmShotStack(app, 'CharmShotStack', {
  env,
  description: 'CharmShot AI image generation backend (API, worker, queues, storage)',
});

app.synth();
