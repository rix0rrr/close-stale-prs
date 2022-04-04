import * as github from '@actions/github';

const STALE_WARNING_MARKER = '<!--STALE PR-->';

export interface StalePrFinderProps {
  readonly owner: string;
  readonly repo: string;
  readonly staleDays: number;
  readonly responseDays: number;
  readonly importantChecksRegex?: RegExp;
  readonly skipLabels?: string[];
  readonly warnMessage?: string;
  readonly closeMessage?: string;
  readonly closeLabel?: string;
}

export type Action = 'nothing' | 'warn' | 'close';

export interface Metrics {
  prsProcessed: number;
  skipped: number;
  stalePrs: number;
  staleDueToChangesRequested: number;
  staleDueToBuildFailing: number;
  warned: number;
  closed: number;
};

export class StalePrFinder {
  public readonly metrics: Metrics = {
    prsProcessed: 0,
    stalePrs: 0,
    staleDueToChangesRequested: 0,
    staleDueToBuildFailing: 0,
    warned: 0,
    closed: 0,
    skipped: 0,
  };

  private readonly client: ReturnType<typeof github.getOctokit>;
  private readonly repo: { owner: string; repo: string };

  constructor(token: string, private readonly props: StalePrFinderProps) {
    this.client = github.getOctokit(token);
    this.repo = { owner: props.owner, repo: props.repo };
  }

  public async findAll() {
    const pulls = await this.client.paginate(this.client.rest.pulls.list, {
      ...this.repo,
      state: 'open',
    });

    // Oldest first, so that if we run out of API credits, we probably
    // made some progress
    pulls.reverse();

    for (const pull of pulls) {
      this.metrics.prsProcessed++;

      // Two states we're interested in
      // - Build failing
      // - Changes requested

      // commit statuses and check runs are apparently 2 different things :(
      console.log('');
      console.log(`------> PR#${pull.number}`);
      if (this.hasSkipLabel(pull.labels)) {
        this.metrics.skipped++;
        console.log('        Skipped due to label.');
        continue;
      }

      const failingChecks = await this.failingChecks(pull.head.sha);
      const changesRequested = await this.isChangesRequested(pull.number);
      const lastCommit = await this.lastCommit(pull.number);

      console.log(`        Build failures:      ${summarizeChecks(failingChecks)}`);
      let buildFailTime = maxTime(failingChecks);

      const regex = this.props.importantChecksRegex;
      if (regex) {
        const importantChecks = Object.fromEntries(Object.entries(failingChecks).filter(([id, _]) => !!id.match(regex)));
        console.log(`        Filtered by regex:   ${summarizeChecks(importantChecks)} <-- using this`);
        buildFailTime = maxTime(importantChecks);
      }

      console.log('        Changes requested:  ', changesRequested?.when?.toISOString() ?? '(no)');
      console.log(`        Last commit:         ${lastCommit?.toISOString()}`);

      // A PR has a problem if:
      // - It has been in CHANGES REQUESTED for a given period and there have not been commits since
      //   (If there have been new commits it's time for a re-review first)
      // - It has been in BUILD FAILING for a given period; or
      let stale: Stale | undefined;

      if (changesRequested && lastCommit
        && lastCommit < changesRequested.when
        && this.stale(changesRequested.when)) {
        this.metrics.staleDueToChangesRequested++;
        stale = {
          reason: 'CHANGES REQUESTED',
          since: changesRequested.when,
        };
      } else if (buildFailTime && this.stale(buildFailTime)) {
        this.metrics.staleDueToBuildFailing++;
        stale = {
          reason: 'BUILD FAILING',
          since: buildFailTime,
        };
      }

      const warnedAt = await this.mostRecentWarning(pull.number);

      console.log('        Stale:              ', stale ? `yes (${stale.reason})` : 'no');

      let action: Action = 'nothing';
      if (stale) {
        this.metrics.stalePrs++;

        console.log('        Stale since:        ', stale.since.toISOString());
        console.log('        Warned at:          ', warnedAt?.toISOString() ?? '(never)');

        if (!warnedAt || warnedAt < stale.since) {
          // Beginning a new staleness period
          action = 'warn';
        } else if (warnedAt && this.outOfGracePeriod(warnedAt)) {
          // Time to close
          action = 'close';
        }
      }

      console.log('        Action:             ', action);
      await this.performAction(pull.number, action, stale);
    }
  }

  private async performAction(pull_number: number, action: Action, stale?: Stale) {
    switch (action) {
      case 'nothing': return;
      case 'warn': {
        this.metrics.warned++;
        const message = this.props.warnMessage?.replace(/STATE/, stale?.reason ?? '') ?? `This PR has been in ${stale?.reason} for ${this.props.staleDays} days, and looks abandoned. It will be closed in ${this.props.responseDays} days if no further commits are pushed to it.`;
        await this.client.rest.issues.createComment({
          ...this.repo,
          issue_number: pull_number,
          body: `${STALE_WARNING_MARKER}\n${message}`,
        });
        return;
      }
      case 'close': {
        this.metrics.closed++;
        throw new Error('Did not expect a CLOSE yet');
        const message = this.props.closeMessage ?? 'No more work is being done on this PR. It will now be closed.';
        await this.client.rest.issues.createComment({
          ...this.repo,
          issue_number: pull_number,
          body: message,
        });
        if (this.props.closeLabel) {
          await this.client.rest.issues.addLabels({
            ...this.repo,
            issue_number: pull_number,
            labels: [this.props.closeLabel ?? ''],
          });
        }
        await this.client.rest.issues.update({
          ...this.repo,
          issue_number: pull_number,
          state: 'closed',
        });
        return;
      }
    }
  }

  private stale(t: Date) {
    const staleMs = this.props.staleDays * 24 * 3600 * 1000;
    return t.getTime() + staleMs < Date.now();
  }

  private outOfGracePeriod(t: Date) {
    const graceMs = this.props.responseDays * 24 * 3600 * 1000;
    return t.getTime() + graceMs < Date.now();
  }

  private async failingChecks(ref: string): Promise<Record<string, FailedCheck>> {
    const ret: Record<string, FailedCheck> = {};

    // Checks == GitHub Actions runs. There may be multiple checks with the same name.
    const checks = await this.client.rest.checks.listForRef({ ...this.repo, ref });
    const uniqueChecks = mostRecent(checks.data.check_runs, 'name', 'completed_at');
    Object.assign(ret, Object.fromEntries(Object.values(uniqueChecks)
      .filter(c => c.conclusion === 'failure' && c.completed_at)
      .map(c => [c.name, { when: new Date(c.completed_at!) } as FailedCheck])));

    // Statuses == Other validation runs (GitPod, CodeBuild, etc)
    const statuses = await this.client.rest.repos.listCommitStatusesForRef({ ...this.repo, ref });
    const uniqueStatuses = mostRecent(statuses.data, 'context', 'updated_at');
    Object.assign(ret, Object.fromEntries(Object.values(uniqueStatuses)
      .filter(c => c.state === 'failure' && c.updated_at)
      .map(c => [c.context, { when: new Date(c.updated_at!) } as FailedCheck])));

    return ret;
  }

  /**
   * Return the most recent ChangesRequested info, if applicable
   */
  private async isChangesRequested(pull_number: number): Promise<ChangesRequested | undefined> {
    const reviews = await this.client.rest.pulls.listReviews({ ...this.repo, pull_number });
    const cr = reviews.data.filter(r => r.state === 'CHANGES_REQUESTED');
    // Sort descending
    cr.sort((a, b) => -(a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''));

    if (cr.length === 0 || !cr[0].submitted_at) {
      return undefined;
    }

    return {
      when: new Date(cr[0].submitted_at),
    };
  }

  private async lastCommit(pull_number: number): Promise<Date | undefined> {
    const commits = await this.client.paginate(this.client.rest.pulls.listCommits, { ...this.repo, pull_number });
    const commitTimes = commits.map(c => c.commit.committer?.date ?? '').filter(c => c);
    const t = commitTimes[commitTimes.length - 1];
    return t ? new Date(t) : undefined;
  }

  private hasSkipLabel(labels: (string | { name?: string })[]): boolean {
    if (!this.props.skipLabels) { return false; }

    return labels
      .map(l => typeof l === 'string' ? l : l.name)
      .some(l => l && this.props.skipLabels?.includes(l));
  }

  /**
   * List the comments and find the last time we marked this PR as stale.
   */
  private async mostRecentWarning(pull_number: number): Promise<Date | undefined> {
    const comments = await this.client.paginate(this.client.rest.issues.listComments, {
      ...this.repo,
      issue_number: pull_number,
    });
    comments.reverse();

    for (const comment of comments) {
      if (comment.body?.includes(STALE_WARNING_MARKER)) {
        return new Date(comment.created_at);
      }
    }

    return undefined;
  }
}

interface ChangesRequested {
  /**
   * Example value: '2022-04-08T07:53:26Z'
   */
  readonly when: Date;
}

interface FailedCheck {
  /**
   * Example value: '2022-04-08T07:53:26Z'
   */
  readonly when: Date;
}

interface Stale {
  readonly reason: string;
  readonly since: Date;
}

function mostRecent<A extends object, K extends keyof A, T extends keyof A>(xs: A[], idKey: K, timeKey: T):
Record<IfString<A[K]>, A> {
  const ret: Record<string, A> = {};
  for (const x of xs) {
    const key: any = x[idKey];
    if (!ret[key] || x[timeKey] > ret[key][timeKey]) {
      ret[key] = x;
    }
  }
  return ret;
}

function maxTime(xs: Record<string, FailedCheck>): Date | undefined {
  if (Object.keys(xs).length === 0) { return undefined; }
  return new Date(Math.max(...Object.values(xs).map(c => c.when.getTime())));
}

function summarizeChecks(xs: Record<string, FailedCheck>): string {
  if (Object.keys(xs).length === 0) { return '(none)'; }
  return `${Object.keys(xs).join(', ')} (last: ${maxTime(xs)?.toISOString()})`;
}

type IfString<A> = A extends string ? A : never;
