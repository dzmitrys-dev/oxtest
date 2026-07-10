import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation } from 'urql';

import {
  EnqueueScan,
  type EnqueueScanData,
  type EnqueueScanVariables,
  type Vulnerability,
} from './graphql';
import { useScanPolling } from './useScanPolling';

/**
 * Bonus A single-screen SPA (FE-01/02/03), implemented to the 06-UI-SPEC.md
 * contract: header → scan form (client-validated) → four-state status region
 * (Queued / Scanning / Finished / Failed) with the CRITICAL results table (D-08).
 *
 * Data flow: onSubmit → useMutation(EnqueueScan) → /graphql → ScanResolver.enqueueScan;
 * the returned id drives useScanPolling → useQuery(GetScan) at 2s → ScanResolver.scan,
 * stopping on the terminal Finished/Failed states.
 *
 * Security (T-06-06): every server-provided field (vulnerability data, the echoed
 * repo URL) is rendered as inert text via React's default escaping; primaryUrl is
 * used ONLY as an href with rel="noopener noreferrer" target="_blank". There is no
 * dangerouslySetInnerHTML anywhere. Client-side URL validation is cosmetic UX only
 * (T-06-07) — the authoritative guard is the server-side parseGithubUrl.
 */

const GITHUB_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

const VALIDATION_ERROR =
  'Enter a valid public GitHub repository URL (https://github.com/owner/repo).';

/** Humanized Failed-state category copy (06-UI-SPEC.md). */
const FAILURE_CATEGORY: Record<string, string> = {
  clone: 'Could not clone the repository',
  trivy: 'The Trivy scan did not complete',
  'disk-full': 'The scan ran out of disk space',
  timeout: 'The scan timed out',
  parse: 'Could not parse the scan report',
  unknown: 'The scan failed unexpectedly',
};

interface ParsedRepo {
  owner: string;
  repo: string;
}

function parseRepo(url: string): ParsedRepo | null {
  const match = GITHUB_URL_RE.exec(url.trim());
  if (match === null) {
    return null;
  }
  const owner = match[1];
  const repo = match[2];
  if (owner === undefined || repo === undefined) {
    return null;
  }
  return { owner, repo };
}

function StatusPill({ label, tone }: { label: string; tone: 'slate' | 'indigo' | 'red' | 'emerald' }): React.JSX.Element {
  const toneClass: Record<typeof tone, string> = {
    slate: 'bg-slate-100 text-slate-600',
    indigo: 'bg-indigo-50 text-indigo-700',
    red: 'bg-red-50 text-red-700',
    emerald: 'bg-emerald-50 text-emerald-700',
  };
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-1 text-sm font-semibold ${toneClass[tone]}`}
    >
      {label}
    </span>
  );
}

function Spinner(): React.JSX.Element {
  return (
    <svg
      className="h-5 w-5 animate-spin text-indigo-600"
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label="Scanning"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
  );
}

function ExternalLinkIcon(): React.JSX.Element {
  return (
    <svg
      className="ml-1 inline h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
    </svg>
  );
}

function ResultsTable({ rows }: { rows: Vulnerability[] }): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
            <th className="px-4 py-2 font-semibold">Package</th>
            <th className="px-4 py-2 font-semibold">CVE</th>
            <th className="px-4 py-2 font-semibold">Installed</th>
            <th className="px-4 py-2 font-semibold">Severity</th>
            <th className="px-4 py-2 font-semibold">Title</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v, i) => (
            <tr
              key={`${v.pkgName}-${v.vulnerabilityId}-${i}`}
              className="border-b border-slate-200 last:border-b-0 odd:bg-slate-50/40"
            >
              <td className="px-4 py-2 font-mono text-slate-900">{v.pkgName}</td>
              <td className="px-4 py-2 font-mono">
                <a
                  className="text-indigo-600 hover:text-indigo-700 hover:underline"
                  href={v.primaryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {v.vulnerabilityId}
                  <ExternalLinkIcon />
                </a>
              </td>
              <td className="px-4 py-2 font-mono text-slate-900">{v.installedVersion}</td>
              <td className="px-4 py-2">
                <span className="inline-flex items-center rounded-md bg-red-50 px-2 py-1 text-xs font-semibold uppercase text-red-700">
                  {v.severity}
                </span>
              </td>
              <td className="px-4 py-2 text-slate-900">{v.title}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function App(): React.JSX.Element {
  const [url, setUrl] = useState('');
  const [touched, setTouched] = useState(false);
  const [scanId, setScanId] = useState<string | null>(null);
  const [submittedRepo, setSubmittedRepo] = useState<string | null>(null);

  const [enqueueState, enqueue] = useMutation<EnqueueScanData, EnqueueScanVariables>(EnqueueScan);
  const scanResult = useScanPolling(scanId);

  const parsed = parseRepo(url);
  const isValid = parsed !== null;
  const showValidationError = touched && url.trim() !== '' && !isValid;

  const scan = scanResult.data?.scan ?? null;
  const status = scan?.status;
  const terminal = status === 'Finished' || status === 'Failed';
  const inFlight = enqueueState.fetching || (scanId !== null && !terminal);

  const buttonDisabled = !isValid || inFlight;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    const repo = parseRepo(url);
    if (repo === null) {
      return;
    }
    const canonical = `https://github.com/${repo.owner}/${repo.repo}`;
    const result = await enqueue({ repoUrl: canonical });
    const newId = result.data?.enqueueScan.id;
    if (newId !== undefined) {
      setScanId(newId);
      setSubmittedRepo(`${repo.owner}/${repo.repo}`);
    }
  }

  function onNewScan(): void {
    setScanId(null);
    setSubmittedRepo(null);
    setUrl('');
    setTouched(false);
  }

  const criticals = scan?.criticalVulnerabilities ?? [];
  const criticalCount = criticals.length;
  const enqueueError = enqueueState.error?.graphQLErrors[0]?.message ?? enqueueState.error?.message;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-3xl px-4 pb-16 pt-12">
        {/* Header */}
        <header className="mb-8">
          <h1 className="text-[28px] font-semibold leading-tight">Code Guardian</h1>
          <p className="mt-1 text-sm text-slate-500">Supply Chain Scanner</p>
        </header>

        {/* Scan form card */}
        <form
          onSubmit={onSubmit}
          className="rounded-lg border border-slate-200 bg-white p-6"
          noValidate
        >
          <label htmlFor="repo-url" className="block text-sm font-semibold text-slate-900">
            GitHub repository URL
          </label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <input
              id="repo-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="https://github.com/owner/repo"
              aria-invalid={showValidationError}
              className="h-10 flex-1 rounded-md border border-slate-200 px-4 text-base outline-none focus:border-indigo-600 focus:ring-2 focus:ring-indigo-600/30"
            />
            <button
              type="submit"
              disabled={buttonDisabled}
              className="h-10 shrink-0 rounded-md bg-indigo-600 px-4 text-base font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {enqueueState.fetching ? 'Starting…' : 'Start scan'}
            </button>
          </div>
          {showValidationError && (
            <p className="mt-2 text-sm text-red-600">{VALIDATION_ERROR}</p>
          )}
          {enqueueError !== undefined && (
            <p className="mt-2 text-sm text-red-600">{enqueueError}</p>
          )}
        </form>

        {/* Status region */}
        {scanId !== null && (
          <section className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
            <div className="mb-4 flex items-center justify-between gap-4">
              <p className="text-sm text-slate-500">
                Scanning{' '}
                <span className="font-mono text-slate-900">{submittedRepo}</span>
              </p>
              <StatusHeaderPill status={status} count={criticalCount} />
            </div>

            <StatusBody
              status={status}
              fetching={scanResult.fetching}
              criticals={criticals}
              criticalCount={criticalCount}
            />

            <div className="mt-6">
              <button
                type="button"
                onClick={onNewScan}
                className="h-10 rounded-md border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-50"
              >
                New scan
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function StatusHeaderPill({
  status,
  count,
}: {
  status: string | undefined;
  count: number;
}): React.JSX.Element {
  if (status === 'Queued') {
    return <StatusPill label="Queued" tone="slate" />;
  }
  if (status === 'Scanning') {
    return <StatusPill label="Scanning" tone="indigo" />;
  }
  if (status === 'Finished') {
    return <StatusPill label="Finished" tone={count > 0 ? 'red' : 'emerald'} />;
  }
  if (status === 'Failed') {
    return <StatusPill label="Failed" tone="red" />;
  }
  return <StatusPill label="Loading" tone="slate" />;
}

function StatusBody({
  status,
  fetching,
  criticals,
  criticalCount,
}: {
  status: string | undefined;
  fetching: boolean;
  criticals: Vulnerability[];
  criticalCount: number;
}): React.JSX.Element {
  if (status === undefined) {
    return (
      <p className="text-base text-slate-500">
        {fetching ? 'Loading scan status…' : 'Waiting for scan status…'}
      </p>
    );
  }

  if (status === 'Queued') {
    return (
      <div>
        <h2 className="text-xl font-semibold">Queued</h2>
        <p className="mt-1 text-base text-slate-500">
          Your scan is in line and will start shortly.
        </p>
      </div>
    );
  }

  if (status === 'Scanning') {
    return (
      <div>
        <div className="flex items-center gap-2">
          <Spinner />
          <h2 className="text-xl font-semibold">Scanning</h2>
        </div>
        <p className="mt-1 text-base text-slate-500">
          Cloning the repository and running Trivy. This can take a minute for a large repo.
        </p>
      </div>
    );
  }

  if (status === 'Finished') {
    if (criticalCount === 0) {
      return (
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold text-emerald-700">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 6 9 17l-5-5" />
            </svg>
            No CRITICAL vulnerabilities found
          </h2>
          <p className="mt-1 text-base text-slate-500">
            Trivy completed the scan and found nothing at CRITICAL severity.
          </p>
        </div>
      );
    }
    return (
      <div>
        <p className="mb-4 text-sm font-semibold text-red-600">
          {criticalCount} CRITICAL {criticalCount === 1 ? 'vulnerability' : 'vulnerabilities'} found
        </p>
        <ResultsTable rows={criticals} />
      </div>
    );
  }

  if (status === 'Failed') {
    // The GraphQL ScanModel (Wave 1) exposes id/status/criticalVulnerabilities only —
    // it does NOT surface the domain `error` reason, and D-08 forbids requesting a
    // field the schema/parser does not provide. Render the humanized generic
    // (unknown-category) failure copy; no error.detail is available over the wire.
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6">
        <h2 className="text-xl font-semibold text-red-700">Scan failed</h2>
        <p className="mt-1 text-base text-red-700">
          {FAILURE_CATEGORY['unknown']}. Check the repository URL and try again.
        </p>
      </div>
    );
  }

  return <p className="text-base text-slate-500">Unknown status: {status}</p>;
}
