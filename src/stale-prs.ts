import * as github from '@actions/github';

export type Marker = 'STALE PR' | 'MERGE CONFLICTS';

export interface StalePrFinderProps {
  readonly owner: string;
  readonly repo: string;
  readonly staleDays: number;
  readonly responseDays: number;

  /**
   * After how many days to warn for merge conflicts
   *
   * 0 disables
   *
   * @default 3
   */
  readonly mergeConflictWarningDays?: number;
  readonly mergeConflictWarning?: string;
  readonly importantChecksRegex?: RegExp;
  readonly skipLabels?: string[];
  readonly warnMessage?: string;
  readonly closeMessage?: string;
  readonly closeLabel?: string;
  readonly dryRun?: boolean;
}

export type Action = 'nothing' | 'warn' | 'close';

export interface Metrics {
  prsProcessed: number;
  skipped: number;
  stalePrs: number;
  staleDueToChangesRequested: number;
  staleDueToBuildFailing: number;
  staleDueToMergeConflicts: number;
  warned: number;
  closed: number;
};

export class StalePrFinder {
  public readonly metrics: Metrics = {
    prsProcessed: 0,
    stalePrs: 0,
    staleDueToChangesRequested: 0,
    staleDueToBuildFailing: 0,
    staleDueToMergeConflicts: 0,
    warned: 0,
    closed: 0,
    skipped: 0,
  };

  private readonly client: ReturnType<typeof github.getOctokit>;
  private readonly repo: { owner: string; repo: string };
  private readonly mergeConflictWarningDays: number;

  constructor(token: string, private readonly props: StalePrFinderProps) {
    this.client = github.getOctokit(token);
    this.repo = { owner: props.owner, repo: props.repo };

    this.mergeConflictWarningDays = props.mergeConflictWarningDays ?? 3;

    if (this.props.dryRun) {
      console.log('Dry run ON');
    }
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
      const reviewState = await this.reviewState(pull.number);
      const lastCommit = await this.lastCommit(pull.number);
      const hasMergeConflicts = (await this.client.rest.pulls.get({ ...this.repo, pull_number: pull.number })).data.mergeable_state === 'dirty';

      const changesRequested = reviewState?.state === 'changes_requested' ? reviewState : undefined;

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
      console.log(`        Merge conflicts:     ${hasMergeConflicts}`);

      // A PR has a problem if:
      // - It has been in CHANGES REQUESTED for a given period and there have not been commits since
      // - It has been in BUILD FAILING for a given period; or
      // - It has been in MERGE CONFLICTS for a given period.
      let stale: Stale | undefined;

      if (reviewState && lastCommit
        && this.stale(reviewState.when)) {
        this.metrics.staleDueToChangesRequested++;
        stale = {
          reason: 'CHANGES REQUESTED',
          since: reviewState.when,
        };
      } else if (buildFailTime && this.stale(buildFailTime)) {
        this.metrics.staleDueToBuildFailing++;
        stale = {
          reason: 'BUILD FAILING',
          since: buildFailTime,
        };
      } else if (hasMergeConflicts) {
        if (lastCommit && this.stale(lastCommit)) {
          this.metrics.staleDueToMergeConflicts++;
          stale = {
            reason: 'MERGE CONFLICTS',
            since: lastCommit,
          };
        } else if (lastCommit && this.mergeConflictWarningDays && this.olderThanDays(lastCommit, this.mergeConflictWarningDays)) {
          await this.addMergeConflictWarning(pull.number);
        }
      }

      const warnings = await this.mostRecentWarnings(pull.number);

      console.log('        Stale:              ', stale ? `yes (${stale.reason})` : 'no');

      let action: Action = 'nothing';
      if (stale) {
        this.metrics.stalePrs++;

        console.log('        Stale since:        ', stale.since.toISOString());
        console.log('        Warnings:           ', Object.fromEntries(warnings)); // Prints nicer

        const memberReviewed = await this.memberReviewed(pull.number);

        const warning = warnings.get('STALE PR');
        if (!warning || warning < stale.since || !memberReviewed) {
          // Beginning a new staleness period
          action = 'warn';
        } else if (warnings && this.outOfGracePeriod(warning)) {
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

        await this.addComment(pull_number, `${marker('STALE PR')}\n${message}`);
        return;
      }
      case 'close': {
        this.metrics.closed++;
        const message = this.props.closeMessage ?? 'No more work is being done on this PR. It will now be closed.';

        await this.addComment(pull_number, message);

        if (this.props.closeLabel) {
          await this.addLabels(pull_number, [this.props.closeLabel ?? '']);
        }

        await this.closeIssue(pull_number);
        return;
      }
    }
  }

  private async addMergeConflictWarning(pull_number: number) {
    const message = this.props.mergeConflictWarning ??
      'This PR cannot be merged because it has conflicts. Please resolve them. The PR will be considered stale and closed if it remains in an unmergeable state.';
    await this.addComment(pull_number, message);
  }

  private async addComment(issue_number: number, body: string) {
    if (this.props.dryRun) {
      console.log(`${issue_number}: COMMENT ${body}`);
      return;
    }
    await this.client.rest.issues.createComment({
      ...this.repo,
      issue_number,
      body,
    });
  }

  private async addLabels(issue_number: number, labels: string[]) {
    if (this.props.dryRun) {
      console.log(`${issue_number}: ADD LABEL ${labels}`);
      return;
    }

    await this.client.rest.issues.addLabels({
      ...this.repo,
      issue_number,
      labels,
    });
  }

  private async closeIssue(issue_number: number) {
    if (this.props.dryRun) {
      console.log(`${issue_number}: CLOSE`);
      return;
    }

    await this.client.rest.issues.update({
      ...this.repo,
      issue_number,
      state: 'closed',
    });
  }

  private stale(t: Date) {
    return this.olderThanDays(t, this.props.staleDays);
  }

  private olderThanDays(t: Date, days: number) {
    const ms = days * 24 * 3600 * 1000;
    return t.getTime() + ms < Date.now();
  }

  private outOfGracePeriod(t: Date) {
    return this.olderThanDays(t, this.props.responseDays);
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
  private async reviewState(pull_number: number): Promise<ReviewState | undefined> {
    const reviews = (await this.client.paginate(this.client.rest.pulls.listReviews, { ...this.repo, pull_number }));
    // Reviews by team members, sorted descending
    // Filtering out instances where submitted_at is empty
    const memberReviews = reviews.filter(r => r.author_association === 'MEMBER').filter(r => r.submitted_at);
    memberReviews.sort((a, b) => (a.submitted_at!).localeCompare(b.submitted_at!));

    const cr = memberReviews.filter(r => r.state === 'CHANGES_REQUESTED');
    const approved = memberReviews.filter(r => r.state === 'APPROVED');

    // Get the oldest PR with changes requested so that a new review with additional changes requested won't reset the clock
    if (cr.length > 0) {
      return {
        state: 'changes_requested',
        when: new Date(cr.pop()!.submitted_at!),
      };
    }

    if (approved.length > 0) {
      return {
        state: 'approved',
        when: new Date(approved[0].submitted_at!),
      };
    }

    return undefined;
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
  private async mostRecentWarnings(pull_number: number): Promise<Map<Marker, Date>> {
    const comments = await this.client.paginate(this.client.rest.issues.listComments, {
      ...this.repo,
      issue_number: pull_number,
    });
    comments.reverse();

    const ret = new Map<Marker, Date>();

    for (const comment of comments) {
      for (const m of ['STALE PR', 'MERGE CONFLICTS'] as Marker[]) {
        if (comment.body?.includes(marker(m)) && !ret.has(m)) {
          ret.set(m, new Date(comment.created_at));
        }
      }
    }

    return ret;
  }

  /**
   * Returns true if the PR has been reviewed or commented on by a core member.
   */
  private async memberReviewed(pull_number: number): Promise<Boolean> {
    const reviews = (await this.client.paginate(this.client.rest.pulls.listReviews, { ...this.repo, pull_number }));

    const comments = await this.client.paginate(this.client.rest.issues.listComments, {
      ...this.repo,
      issue_number: pull_number,
    });

    // Reviews by team members
    // Filtering out instances where submitted_at is empty
    const memberReviews = reviews.filter(r => r.author_association === 'MEMBER').filter(r => r.submitted_at);

    // Comments by team members
    // Filtering out instances where submitted_at is empty
    const memberComments = comments.filter(r => r.author_association === 'MEMBER').filter(r => r.submitted_at);

    return memberComments.length > 0 || memberReviews.length > 0;
  }
}

interface ReviewState {
  readonly state: 'approved' | 'changes_requested';

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


function marker(m: Marker) {
  return `<!--${m}-->`;
}
