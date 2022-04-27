const { actions } = require('projen');
const project = new actions.GitHubActionTypeScriptProject({
  defaultReleaseBranch: 'main',
  name: 'close-stale-prs',
  deps: ['@octokit/graphql'],
  metadata: {
    author: 'Rico Huijbers',
    inputs: {
      'github-token': {
        description: 'GitHub token',
        required: true,
      },
      'stale-days': {
        description: 'how many days before a PR is considered stale',
        required: true,
      },
      'response-days': {
        description: 'how many days before a stale PR is closed',
        required: true,
      },
      'important-checks-regex': {
        description: 'Regex to determine which checks need to be watched (default: all checks)',
        required: false,
      },
      'skip-labels': {
        description: 'Comma-separated list of labels to ignore',
        required: false,
      },
      'warn-message': {
        description: 'Message to post to PR when grace period is entered. The word STATE will be replaced with the actual state.',
        required: false,
      },
      'close-message': {
        description: 'Message to post to PR when PR is finally closed.',
        required: false,
      },
      'close-label': {
        description: 'Label to add if the PR is finally closed',
        required: false,
      },
      'dry-run': {
        description: 'If this is set, do not perform any actions',
        required: false,
      },
    },
    outputs: {
    },
    branding: {
      color: 'blue',
      icon: 'archive',
    },
  },
});
project.synth();