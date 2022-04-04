# Close Stale PRs GitHub Action

Common "stale issue/PR" GitHub Actions will trigger on any activity
from either side.

That means they may close PRs when the problem may be that maintainers simply
haven't gotten around to reviewing it properly (bad for contributors).

It also means they don't look at PR-specific signals, like failing builds.
A non-building PR is not mergeable, and review effort by the reviewer is
probably wasted (bad for maintainers).

This GitHub Action specifically triggers on two conditions:

- Changed requested: changes have been requested longer than X days ago,
  but nothing has happened since.
- Build failing: the PR has been in build failing for X days, and nothing
  has happened since.

In both of those cases, it will warn of the impending closure, and then
close the PR Y days later.

This will hopefully keep the PR backlog clean and actionable.

## Usage

Configure an action that runs once per day:

```yaml
on:
  schedule:
    # Cron format: min hr day month dow
    - cron: "0 0 * * *"
jobs:
  rix0rrr/close-stale-prs:
    permissions:
      pull-requests: write
    runs-on: ubuntu-latest
    steps:
      - uses: rix0rrr/close-stale-prs@main
        with:
          # Required
          github-token: ${{ secrets.GITHUB_TOKEN }}
          stale-days: 21
          response-days: 10

          # Optional
          important-checks-regex: build1|build2
          skip-labels: label1,label2
          warn-message: <message>
          close-message: <message>
          close-label: some-label
```
