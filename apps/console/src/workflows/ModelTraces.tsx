import { useId, useLayoutEffect, useRef } from 'react';
import { DraftLog } from './DraftLog.js';
import { previewObject } from './draft-preview.js';
import type { DraftRequestProgress } from './draft-request-progress.js';

export function ModelTraces({
  progress,
  id,
  collapsed = false,
  onCollapse,
  onExpand,
}: {
  progress?: DraftRequestProgress | undefined;
  id?: string;
  collapsed?: boolean;
  onCollapse?: () => void;
  onExpand?: () => void;
}) {
  const logId = useId();
  const sidebarRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const log = scrollRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [progress, collapsed]);

  useLayoutEffect(() => {
    const log = scrollRef.current;
    const content = contentRef.current;
    if (!log || !content) return;
    const observer = new ResizeObserver(() => {
      log.scrollTop = log.scrollHeight;
    });
    observer.observe(content);
    observer.observe(log);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    const topbar = sidebar?.closest('.shell-main')?.querySelector<HTMLElement>('.topbar');
    if (!sidebar || !topbar) return;
    const updateTop = () => {
      sidebar.style.setProperty(
        '--wf-traces-top',
        `${Math.max(0, topbar.getBoundingClientRect().bottom)}px`,
      );
    };
    updateTop();
    const observer = new ResizeObserver(updateTop);
    observer.observe(topbar);
    window.addEventListener('scroll', updateTop, { passive: true });
    window.addEventListener('resize', updateTop);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', updateTop);
      window.removeEventListener('resize', updateTop);
    };
  }, []);

  const running = !progress || progress.status === 'running';
  const result = previewObject(progress?.result?.body);
  const blocked = result.status === 'unsupported' || result.status === 'manual_review';
  const outcomeMessage = blocked
    ? typeof result.detail === 'string'
      ? result.detail
      : typeof result.reason === 'string'
        ? result.reason
        : undefined
    : undefined;
  const status = running
    ? progress?.stage === 'understanding'
      ? 'Thinking'
      : progress?.stage === 'validating'
        ? 'Checking draft'
        : progress?.stage === 'repairing'
          ? 'Repairing draft'
          : 'Working'
    : progress.status === 'failed'
      ? 'Drafting failed'
      : progress.status === 'cancelled'
        ? 'Draft cancelled'
        : result.status === 'unsupported'
          ? 'Workflow could not be drafted'
          : result.status === 'manual_review'
            ? 'Workflow needs review'
            : null;

  return (
    <aside
      id={id}
      ref={sidebarRef}
      className={`wf-model-traces${collapsed ? ' is-collapsed' : ''}`}
      aria-label="Model traces"
    >
      <header className="wf-model-traces-heading">
        <h2 hidden={collapsed}>Model traces</h2>
        {(onCollapse || onExpand) && (
          <button
            type="button"
            className="wf-action wf-traces-collapse"
            aria-label={collapsed ? 'Expand model traces' : 'Collapse model traces'}
            title={collapsed ? 'Expand model traces' : 'Collapse model traces'}
            aria-expanded={!collapsed}
            aria-controls={logId}
            onClick={collapsed ? onExpand : onCollapse}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d={collapsed ? 'M15 4v16M11 9l-3 3 3 3' : 'M15 4v16M8 9l3 3-3 3'} />
            </svg>
          </button>
        )}
        {status && (
          <p hidden={collapsed} className="wf-model-traces-status" role="status">
            {running && <span className="wf-draft-spinner" aria-hidden="true" />}
            {status}
          </p>
        )}
      </header>
      <div
        id={logId}
        hidden={collapsed}
        ref={scrollRef}
        className="wf-model-traces-scroll"
        role="region"
        aria-label="AI trace log"
        tabIndex={0}
      >
        <div ref={contentRef}>
          {(progress?.error || outcomeMessage) && (
            <p className="wf-error">{progress?.error ?? outcomeMessage}</p>
          )}
          {progress && <DraftLog progress={progress} />}
        </div>
      </div>
    </aside>
  );
}
