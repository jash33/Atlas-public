import { useEffect, useRef, useState, type CSSProperties } from 'react';

import {
  handleSuggestionKey,
  markAnnotationAsRuntimeInput,
  removeAnnotation,
  requestHighlightSegments,
  selectSuggestion,
  suggestionListbox,
  syncRequest,
  tooltipForAnnotation,
  type RequestEditor,
  type Suggestion,
  type SuggestionKind,
} from './request-editor.js';
import './request-editor.css';
import {
  lastKnownDefinitionMessage,
  usesLastKnownDefinition,
} from './capability-definition-status.js';

const groupLabels: Record<SuggestionKind, string> = {
  capability: 'Capabilities',
  'request-field': 'Request fields',
  'response-field': 'Response fields',
};

export function RequestPromptEditor({
  canDraft,
  editor,
  isLoading = false,
  onEditorChange,
  onOpenCapability,
}: {
  canDraft: boolean;
  editor: RequestEditor;
  isLoading?: boolean;
  onEditorChange: (editor: RequestEditor) => void;
  onOpenCapability?: (capabilityVersionId: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const ignoreSelectionRestore = useRef(true);
  const [isReferenceHovered, setIsReferenceHovered] = useState(false);
  const [hoveredStart, setHoveredStart] = useState<number | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const [suggestionAnchor, setSuggestionAnchor] = useState({ left: 12, top: 40 });
  const listbox = suggestionListbox(editor);
  const showSuggestions = canDraft && editor.list.open && listbox.options.length > 0;
  const focused = editor.annotations.find(
    (range) => editor.cursor >= range.start && editor.cursor < range.end,
  );
  const tooltipAnnotation =
    editor.annotations.find((range) => range.start === hoveredStart) ?? focused;
  const tooltip = tooltipAnnotation ? tooltipForAnnotation(editor, tooltipAnnotation) : null;

  useEffect(() => {
    if (ignoreSelectionRestore.current) {
      ignoreSelectionRestore.current = false;
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (textarea.selectionStart !== editor.cursor || textarea.selectionEnd !== editor.cursor) {
      textarea.setSelectionRange(editor.cursor, editor.cursor);
    }
  }, [editor.cursor, editor.text]);

  function syncFromTextarea(event: { currentTarget: HTMLTextAreaElement }) {
    const target = event.currentTarget;
    ignoreSelectionRestore.current = true;
    setSuggestionAnchor(caretAnchor(target));
    onEditorChange(syncRequest(editor, target.value, target.selectionStart ?? target.value.length));
  }

  function syncScroll() {
    if (highlightRef.current && textareaRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }

  function annotationAtPoint(clientX: number, clientY: number) {
    return editor.annotations.find((range) => {
      const mark = highlightRef.current?.querySelector(`mark[data-ref-start="${range.start}"]`);
      if (!(mark instanceof HTMLElement)) return false;
      return Array.from(mark.getClientRects()).some(
        (box) =>
          clientX >= box.left &&
          clientX <= box.right &&
          clientY >= box.top &&
          clientY <= box.bottom,
      );
    });
  }

  return (
    <div className="wf-request-editor">
      <div className="wf-request-compose">
        <div className="wf-request-stack">
          <div aria-hidden="true" className="wf-request-highlight" ref={highlightRef}>
            {requestHighlightSegments(editor).map((segment, index) =>
              segment.type === 'text' ? (
                <span key={`text:${index}`}>{segment.value}</span>
              ) : (
                <mark
                  className={
                    segment.annotation.kind === 'runtime-input'
                      ? 'wf-ref wf-ref-runtime-input wf-ref-identified-input'
                      : 'wf-ref wf-ref-identified-reference'
                  }
                  data-ref-start={segment.annotation.start}
                  key={`ref:${segment.annotation.start}:${segment.annotation.end}:${
                    segment.annotation.kind === 'runtime-input'
                      ? segment.annotation.inputName
                      : segment.annotation.capabilityVersionId
                  }`}
                >
                  {segment.value}
                </mark>
              ),
            )}
          </div>
          {isLoading && <div aria-hidden="true" className="wf-request-loading-border" />}
          {tooltip && (
            <div
              className="wf-ref-tooltip"
              id="wf-ref-tooltip"
              role="tooltip"
              onMouseEnter={() => clearTimeout(hoverTimer.current)}
              onMouseLeave={() => setHoveredStart(null)}
            >
              {'kind' in tooltip && tooltip.kind === 'runtime-input' ? (
                <>
                  <strong>Runtime input</strong>
                  <code>{tooltip.inputName}</code>
                </>
              ) : (
                <>
                  <strong>
                    {tooltipAnnotation?.kind === 'capability'
                      ? 'Capability'
                      : tooltipAnnotation?.kind === 'request-field'
                        ? 'Request field'
                        : 'Response field'}
                  </strong>
                  <p>
                    {tooltip.serviceId} · {tooltip.operationId}
                  </p>
                  <p>Owner: {tooltip.owner}</p>
                  {tooltip.direction && tooltip.path && (
                    <p>
                      {tooltip.direction} {tooltip.path}
                    </p>
                  )}
                  <p>{tooltip.provenanceSummary}</p>
                  {usesLastKnownDefinition(tooltip.observation) && (
                    <p>{lastKnownDefinitionMessage}</p>
                  )}
                </>
              )}
              {tooltipAnnotation && (
                <div className="wf-ref-tooltip-actions">
                  {!('kind' in tooltip) && (
                    <>
                      {onOpenCapability && (
                        <button
                          aria-label={`Open ${tooltip.serviceId} · ${tooltip.operationId} capability details`}
                          onClick={() => onOpenCapability(tooltip.capabilityVersionId)}
                          onMouseDown={(event) => event.preventDefault()}
                          type="button"
                        >
                          View capability
                        </button>
                      )}
                      <button
                        aria-label={`Mark ${editor.text.slice(tooltipAnnotation.start, tooltipAnnotation.end)} as runtime input`}
                        onClick={() => {
                          onEditorChange(markAnnotationAsRuntimeInput(editor, tooltipAnnotation));
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        type="button"
                      >
                        Runtime input
                      </button>
                    </>
                  )}
                  <button
                    aria-label={`Remove grounding for ${editor.text.slice(tooltipAnnotation.start, tooltipAnnotation.end)}`}
                    className="wf-ref-remove"
                    onClick={() => {
                      onEditorChange(removeAnnotation(editor, tooltipAnnotation));
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    title="Remove grounding"
                    type="button"
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
          )}
          <textarea
            aria-activedescendant={showSuggestions ? listbox['aria-activedescendant'] : undefined}
            aria-autocomplete={canDraft ? 'list' : undefined}
            aria-controls={canDraft ? listbox.id : undefined}
            aria-expanded={canDraft ? listbox['aria-expanded'] : undefined}
            aria-describedby={tooltip ? 'wf-ref-tooltip' : undefined}
            aria-haspopup={canDraft ? 'listbox' : undefined}
            aria-busy={isLoading || undefined}
            className={isReferenceHovered ? 'is-reference-hovered' : undefined}
            id="workflow-prompt"
            onBlur={() => {
              if (editor.list.open) onEditorChange(handleSuggestionKey(editor, 'Escape'));
            }}
            onChange={syncFromTextarea}
            onClick={(event) => {
              const annotation = annotationAtPoint(event.clientX, event.clientY);
              if (!annotation) {
                syncFromTextarea(event);
                return;
              }
              const target = event.currentTarget;
              const cursor = Math.min(
                Math.max(target.selectionStart ?? annotation.start, annotation.start),
                annotation.end - 1,
              );
              ignoreSelectionRestore.current = true;
              setSuggestionAnchor(caretAnchor(target));
              onEditorChange(syncRequest(editor, target.value, cursor));
            }}
            onKeyDown={(event) => {
              if (!canDraft || !editor.list.open) return;
              if (
                event.key === 'ArrowDown' ||
                event.key === 'ArrowUp' ||
                event.key === 'Enter' ||
                event.key === 'Escape' ||
                event.key === 'Tab'
              ) {
                event.preventDefault();
                onEditorChange(handleSuggestionKey(editor, event.key));
              }
            }}
            onKeyUp={syncFromTextarea}
            onMouseLeave={() => {
              setIsReferenceHovered(false);
              hoverTimer.current = setTimeout(() => setHoveredStart(null), 150);
            }}
            onMouseMove={(event) => {
              clearTimeout(hoverTimer.current);
              const annotation = annotationAtPoint(event.clientX, event.clientY);
              setIsReferenceHovered(Boolean(annotation));
              setHoveredStart(annotation?.start ?? null);
            }}
            onScroll={syncScroll}
            onSelect={syncFromTextarea}
            ref={textareaRef}
            rows={7}
            value={editor.text}
          />
          {showSuggestions && (
            <ul
              aria-label="Capability references"
              className="wf-suggestions"
              id={listbox.id}
              role="listbox"
              style={
                {
                  '--wf-suggestion-left': `${suggestionAnchor.left}px`,
                  '--wf-suggestion-top': `${suggestionAnchor.top}px`,
                } as CSSProperties
              }
            >
              {listbox.options.map((option, index) => {
                const previous = listbox.options[index - 1];
                return (
                  <SuggestionOption
                    key={option.id}
                    onSelect={(suggestion) => onEditorChange(selectSuggestion(editor, suggestion))}
                    option={option}
                    showGroup={!previous || previous.suggestion.kind !== option.suggestion.kind}
                  />
                );
              })}
            </ul>
          )}
        </div>
      </div>
      {canDraft && (
        <p className="wf-ref-legend">
          Type <code>@</code> to search existing capabilities and fields. References are provisional
          until Atlas validates the draft.
        </p>
      )}
      {editor.indexStatus === 'stale' && (
        <p className="wf-index-note">
          Capability references are stale for this projection. Suggestions are hidden until the
          index refreshes.
        </p>
      )}
      {(editor.indexStatus === 'unavailable' || editor.indexStatus === 'invalid') && (
        <p className="wf-index-note">Capability references are unavailable.</p>
      )}
    </div>
  );
}

function caretAnchor(textarea: HTMLTextAreaElement) {
  const mirror = document.createElement('div');
  const marker = document.createElement('span');
  const style = getComputedStyle(textarea);
  const copiedProperties = [
    'borderLeftWidth',
    'borderTopWidth',
    'boxSizing',
    'fontFamily',
    'fontSize',
    'fontStyle',
    'fontWeight',
    'letterSpacing',
    'lineHeight',
    'paddingLeft',
    'paddingRight',
    'paddingTop',
    'paddingBottom',
    'textTransform',
    'wordSpacing',
  ] as const;
  for (const property of copiedProperties) mirror.style[property] = style[property];
  mirror.style.position = 'fixed';
  mirror.style.left = '-10000px';
  mirror.style.top = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.textContent = textarea.value.slice(0, textarea.selectionStart ?? textarea.value.length);
  marker.textContent = '\u200b';
  mirror.append(marker);
  document.body.append(mirror);
  const lineHeight = Number.parseFloat(style.lineHeight) || 24;
  const popupWidth = Math.min(360, Math.max(220, textarea.clientWidth - 16));
  const anchor = {
    left: Math.max(
      8,
      Math.min(marker.offsetLeft - textarea.scrollLeft, textarea.clientWidth - popupWidth - 8),
    ),
    top: Math.max(8, marker.offsetTop + lineHeight - textarea.scrollTop + 2),
  };
  mirror.remove();
  return anchor;
}

function SuggestionOption({
  onSelect,
  option,
  showGroup,
}: {
  onSelect: (suggestion: Suggestion) => void;
  option: ReturnType<typeof suggestionListbox>['options'][number];
  showGroup: boolean;
}) {
  return (
    <>
      {showGroup && (
        <li className="wf-suggestion-group" role="presentation">
          {groupLabels[option.suggestion.kind]}
        </li>
      )}
      <li
        aria-selected={option['aria-selected']}
        className="wf-suggestion"
        id={option.id}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onSelect(option.suggestion)}
        role="option"
      >
        <strong>{option.suggestion.label}</strong>
        {usesLastKnownDefinition(option.suggestion.observation) && (
          <small className="wf-suggestion-definition-note">Last known definition</small>
        )}
        <small>
          {option.suggestion.identity.serviceId} · {option.suggestion.identity.operationId}
          {option.suggestion.direction && option.suggestion.path
            ? ` · ${option.suggestion.direction} ${option.suggestion.path}`
            : ''}
        </small>
      </li>
    </>
  );
}
