import { useState } from 'react';

import {
  capabilities,
  sources,
  statusLabels,
  type CapabilityConfidence,
  type SourceEvidence,
} from './mock-confidence.js';
import './evidence-monitoring.css';

function Score({ capability }: { capability: CapabilityConfidence }) {
  const score = capability.score;
  const tone = score === null ? 'unknown' : score >= 85 ? 'high' : score >= 60 ? 'mixed' : 'low';
  return (
    <span
      className={`ec-score ec-score-${tone}`}
      aria-label={
        score === null
          ? 'Confidence not assessed'
          : `Illustrative contract confidence ${score} out of 100`
      }
    >
      <strong>{score ?? '—'}</strong>
      <span>{score === null ? 'Not assessed' : '/ 100'}</span>
      {score !== null && (
        <span className="ec-score-track" aria-hidden="true">
          <span style={{ width: `${score}%` }} />
        </span>
      )}
    </span>
  );
}

function SourceStatus({ evidence }: { evidence: SourceEvidence }) {
  return (
    <span className={`ec-source-status ec-source-${evidence.status}`} title={evidence.detail}>
      <span aria-hidden="true" />
      {statusLabels[evidence.status]}
    </span>
  );
}

// Static preview. No score calculation, collection, approval, or customer data.
export function EvidenceMonitoringPrototype() {
  const [query, setQuery] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [selectedId, setSelectedId] = useState('getInvoice');
  const visible = capabilities.filter(
    (capability) =>
      `${capability.id} ${capability.service}`.toLowerCase().includes(query.toLowerCase()) &&
      (!attentionOnly || capability.score === null || capability.score < 60),
  );
  const selected = visible.find(({ id }) => id === selectedId) ?? visible[0];

  return (
    <section className="ec-page" aria-label="Capability evidence monitoring">
      <header className="ec-heading">
        <div>
          <h1>Contract confidence</h1>
          <p>How sure are we that each capability’s contract is current?</p>
        </div>
        <span className="ec-preview">Static preview · illustrative scores</span>
      </header>
      <div className="ec-toolbar">
        <label className="ec-search">
          <span className="ec-sr-only">Search capabilities</span>
          <input
            type="search"
            placeholder="Search capabilities or services"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="ec-filter"
          aria-pressed={attentionOnly}
          onClick={() => setAttentionOnly(!attentionOnly)}
        >
          Needs attention{' '}
          <span>{capabilities.filter(({ score }) => score === null || score < 60).length}</span>
        </button>
        <span className="ec-count">
          {visible.length} of {capabilities.length} examples
        </span>
      </div>
      <div
        className="ec-table-scroll"
        role="region"
        aria-label="Capability confidence and evidence sources"
        tabIndex={0}
      >
        <table className="ec-table">
          <caption className="ec-sr-only">
            Illustrative capability confidence and the status of all five evidence sources. Select a
            capability for details.
          </caption>
          <thead>
            <tr>
              <th scope="col">Capability</th>
              <th scope="col">Confidence</th>
              {sources.map((source) => (
                <th scope="col" key={source.id}>
                  <span title={source.description}>{source.label}</span>
                </th>
              ))}
              <th scope="col">Last evidence</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((capability) => (
              <tr
                key={capability.id}
                className={capability.id === selected?.id ? 'ec-selected' : ''}
              >
                <th scope="row">
                  <button
                    type="button"
                    aria-pressed={selected?.id === capability.id}
                    onClick={() => setSelectedId(capability.id)}
                  >
                    <strong>{capability.id}</strong>
                    <small>{capability.service}</small>
                  </button>
                </th>
                <td>
                  <Score capability={capability} />
                </td>
                {sources.map((source) => (
                  <td key={source.id}>
                    <SourceStatus evidence={capability.evidence[source.id]} />
                  </td>
                ))}
                <td className="ec-time">{capability.lastChecked}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && (
          <p className="ec-empty">
            No capabilities match. Try another search or turn off Needs attention.
          </p>
        )}
      </div>
      <p className="ec-caption">
        Missing sources aren’t automatically a problem. Confidence reflects the quality, freshness,
        and agreement of available evidence.
      </p>

      {selected && (
        <section className="ec-inspector" aria-label={`${selected.id} evidence details`}>
          <div className="ec-summary">
            <div className="ec-summary-heading">
              <div>
                <span className="ec-kicker">Selected capability</span>
                <h2>{selected.id}</h2>
              </div>
              <Score capability={selected} />
            </div>
            <p className="ec-reason">{selected.reason}</p>
            <dl className="ec-identity">
              <div>
                <dt>Contract</dt>
                <dd>{selected.contract}</dd>
              </div>
              <div>
                <dt>Build</dt>
                <dd>{selected.build}</dd>
              </div>
            </dl>
            <p className="ec-route">
              {selected.method} {selected.path}
            </p>
            <div className="ec-summary-note">
              <strong>Still unknown</strong>
              <p>{selected.gap}</p>
            </div>
            <div className="ec-summary-note">
              <strong>Next step</strong>
              <p>{selected.next}</p>
            </div>
            <details className="ec-impact">
              <summary>Workflow impact</summary>
              <p>{selected.impact}</p>
              <small>
                Scores do not approve contracts, clear incidents, or change running workflows.
              </small>
            </details>
          </div>
          <div className="ec-source-list">
            <div className="ec-source-list-heading">
              <h3>What we can see</h3>
              <span>All 5 sources</span>
            </div>
            {sources.map((source) => (
              <div className="ec-source-detail" key={`${selected.id}-${source.id}`}>
                <div className="ec-source-detail-title">
                  <strong>{source.name}</strong>
                  <SourceStatus evidence={selected.evidence[source.id]} />
                </div>
                <p>{selected.evidence[source.id].detail}</p>
                <small>Last check: {selected.evidence[source.id].checked}</small>
              </div>
            ))}
          </div>
        </section>
      )}

      <details className="ec-explainer">
        <summary>About the scores and sources</summary>
        <p>
          Scores are mock examples on a 0–100 index, not measured probabilities. A scoring method
          has not been implemented. No evidence is shown as “Not assessed.”
        </p>
        <p>
          Recent checks for the deployed build support confidence. Conflicts, stale evidence, and
          untested expectations lower it. Two strong sources can be enough; connecting all five does
          not guarantee a current contract.
        </p>
        <p>
          “Current” means that source is recent, not that the whole contract is verified. Candidate
          tests stay separate from production. Passing cases do not cover untested behavior, and an
          internal database change is not automatically an API break.
        </p>
        <ul>
          {sources.map((source) => (
            <li key={source.id}>
              <strong>{source.name}:</strong> {source.description}{' '}
              <a
                href={`https://github.com/jash33/Atlas-public/issues/${source.issue}`}
                target="_blank"
                rel="noreferrer"
              >
                Research #{source.issue}
              </a>
            </li>
          ))}
        </ul>
      </details>
      <footer className="ec-footer">
        Mock Production estate · 11 Sep 2026, 10:20 UTC · independent of the environment picker · no
        live monitoring
      </footer>
    </section>
  );
}
