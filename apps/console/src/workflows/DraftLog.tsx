import { useState } from 'react';
import { DraftPreview } from './DraftPreview.js';
import type { DraftRequestProgress } from './draft-request-progress.js';

export function DraftLog({ progress }: { progress: DraftRequestProgress }) {
  const [copyStatus, setCopyStatus] = useState('');
  const [copying, setCopying] = useState(false);
  const events = progress.events ?? [];
  const result = progress.result?.body;
  const draftCreated =
    progress.status === 'completed' &&
    result !== null &&
    typeof result === 'object' &&
    'status' in result &&
    result.status === 'validated';
  async function copy() {
    setCopying(true);
    setCopyStatus('');
    try {
      await navigator.clipboard.writeText(JSON.stringify(progress, null, 2));
      setCopyStatus('Draft log copied.');
    } catch {
      setCopyStatus('Could not copy the log. Try again or download it instead.');
    } finally {
      setCopying(false);
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(progress, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `draft-${progress.requestId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  return (
    <>
      <div className="wf-draft-log-actions">
        <button
          className="wf-draft-log-icon"
          type="button"
          onClick={download}
          aria-label="Download draft log"
          title="Download draft log"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4" />
          </svg>
        </button>
        <button
          className="wf-draft-log-icon"
          type="button"
          onClick={() => void copy()}
          disabled={copying}
          aria-label={copying ? 'Copying draft log' : 'Copy draft log'}
          title="Copy draft log"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M16 8V4H4v12h4" />
          </svg>
        </button>
      </div>
      {copyStatus && <p role="status">{copyStatus}</p>}
      <DraftPreview progress={progress} />
      {draftCreated && (
        <p className="wf-reasoning-success" role="status">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m5 13 4 4L19 7" />
          </svg>
          <span>Workflow draft successfully created.</span>
        </p>
      )}
      {events.some((event) => event.kind === 'trace.truncated') && (
        <p>The saved log reached its 4 MB limit.</p>
      )}
    </>
  );
}
