import * as core from '@actions/core';
import * as github from '@actions/github';
import { StalePrFinder } from './stale-prs';

async function run() {
  const token: string = core.getInput('github-token', { required: true });
  const staleDays: string = core.getInput('stale-days', { required: true });
  const responseDays: string = core.getInput('response-days', { required: true });
  const importantChecksRegex: string = core.getInput('important-checks-regex');
  const skipLabels: string = core.getInput('skip-labels');
  const warnMessage: string = core.getInput('warn-message');
  const closeMessage: string = core.getInput('close-message');
  const closeLabel: string = core.getInput('close-label');

  const finder = new StalePrFinder(token, {
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    staleDays: verifyInt(staleDays),
    responseDays: verifyInt(responseDays),
    importantChecksRegex: importantChecksRegex ? new RegExp(importantChecksRegex) : undefined,
    skipLabels: skipLabels ? skipLabels.split(',') : undefined,
    warnMessage: warnMessage ? warnMessage : undefined,
    closeMessage: closeMessage ? closeMessage : undefined,
    closeLabel: closeLabel ? closeLabel : undefined,
  });

  await finder.findAll();

  console.log('Metrics', finder.metrics);
}

function verifyInt(x: string): number {
  const num = parseInt(x, 10);
  if (`${num}` !== x) {
    throw new Error(`Not a number: ${x}`);
  }
  return num;
}

run().catch(error => {
  core.setFailed(error.message);
});
