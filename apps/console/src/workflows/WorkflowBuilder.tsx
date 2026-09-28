import {
  createContext,
  useContext,
  useId,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type OnNodesChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './builder.css';

import {
  BUILDER_START_ID,
  addBuilderBlock,
  arrangeBuilder,
  builderConnectionAllowed,
  builderConnections,
  builderIssues,
  builderObject,
  builderReadOnlyReason,
  builderSchema,
  builderStepEditable,
  builderStepLabel,
  builderBlockWidth,
  builderSteps,
  builderText,
  builderValueOptions,
  connectBuilder,
  disconnectBuilder,
  duplicateBuilderBlock,
  removeBuilderBlocks,
  updateBuilderStep,
  type BuilderBlockKind,
  type BuilderCapability,
  type BuilderConnection,
  type BuilderDocument,
  type BuilderIssue,
  type BuilderStep,
} from './builder-model.js';
import {
  BuilderCapabilityField,
  BuilderExpressionField,
  BuilderJsonField,
  BuilderSchemaField,
} from './WorkflowBuilderFields.js';
import { usesLastKnownDefinition } from './capability-definition-status.js';

export interface WorkflowBuilderProps {
  document: BuilderDocument;
  onChange: (document: BuilderDocument) => void;
  capabilities: readonly BuilderCapability[];
  readOnly?: boolean;
  disabled?: boolean;
  issues?: readonly BuilderIssue[];
  status?: Readonly<Record<string, string>>;
}

const palette: Array<{
  kind: BuilderBlockKind;
  title: string;
  description: string;
  symbol: string;
}> = [
  {
    kind: 'capabilityCall',
    title: 'Capability',
    description: 'Run an authorized capability',
    symbol: '◇',
  },
  {
    kind: 'transform',
    title: 'Set fields',
    description: 'Shape data for the next step',
    symbol: '{}',
  },
  {
    kind: 'condition',
    title: 'Conditional',
    description: 'Choose a path using a rule',
    symbol: '⑂',
  },
  { kind: 'sleep', title: 'Sleep', description: 'Wait before continuing', symbol: '◷' },
  { kind: 'terminal', title: 'Finish', description: 'Choose the final result', symbol: '◉' },
  { kind: 'note', title: 'Note', description: 'Leave a note on the canvas', symbol: '▤' },
];

type BlockNode = Node<
  {
    label: string;
    kind: string;
    subtitle: string;
    issueCount: number;
    status?: string;
    locked: boolean;
    lastKnownDefinition?: boolean;
  },
  'block'
>;

const BlockEditorContext = createContext<{
  document: BuilderDocument;
  capabilities: readonly BuilderCapability[];
  locked: boolean;
  commit: (document: BuilderDocument) => void;
  openSettings: (id: string) => void;
  removeBlock: (id: string) => void;
} | null>(null);

function StartFields({
  document,
  disabled,
  onChange,
}: {
  document: BuilderDocument;
  disabled: boolean;
  onChange: (document: BuilderDocument) => void;
}) {
  const id = useId();
  const schema = builderSchema(builderObject(document.executable).inputSchema);
  return (
    <>
      <label htmlFor={id}>Start method</label>
      <select
        className="nodrag"
        id={id}
        disabled={disabled}
        value={document.trigger.type}
        onChange={(event) =>
          onChange({
            ...document,
            trigger: { type: event.target.value === 'webhook' ? 'webhook' : 'manual' },
          })
        }
      >
        <option value="manual">Manual / API</option>
        <option value="webhook">Webhook</option>
      </select>
      <p className="wb-help">These inputs are available to later steps.</p>
      <div className="wb-output-fields">
        {Object.entries(schema.required).map(([name, value]) => (
          <div key={name}>
            <code>{name}</code>
            <small>{value.type}</small>
          </div>
        ))}
      </div>
      {!Object.keys(schema.required).length && <p className="wb-help">No input fields yet.</p>}
      <details>
        <summary className="nodrag">Edit input fields</summary>
        <BuilderSchemaField
          schema={schema}
          disabled={disabled}
          onChange={(inputSchema) =>
            onChange({
              ...document,
              executable: { ...builderObject(document.executable), inputSchema },
            })
          }
        />
      </details>
    </>
  );
}

function WorkflowBlock({ id, data, selected }: NodeProps<BlockNode>) {
  const editor = useContext(BlockEditorContext);
  const step = editor && builderSteps(editor.document).find((step) => step.id === id);
  const outputSchema = builderSchema(step?.responseSchema);
  const kind = data.kind;
  const capabilityCard =
    !!step &&
    ['capabilityCall', 'publishEvent', 'notify', 'compensation'].includes(kind) &&
    !data.locked;
  const symbol =
    kind === 'start' ? '↗' : (palette.find((entry) => entry.kind === kind)?.symbol ?? '◇');
  const noConnection = kind === 'note' || kind === 'compensation' || data.locked;
  return (
    <div
      className={`wb-block wb-block-${kind}${capabilityCard ? ' wb-capability-card' : ''}${selected ? ' is-selected' : ''}${data.issueCount ? ' has-issue' : ''}`}
      tabIndex={0}
      role="group"
      aria-label={`${data.label} block`}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(
            'input, select, textarea, button, label, summary, a, .react-flow__handle',
          )
        )
          return;
        editor?.openSettings(id);
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          editor?.openSettings(id);
        }
      }}
    >
      {kind !== 'start' && !noConnection && (
        <Handle type="target" position={Position.Left} id="in" />
      )}
      <div className="wb-block-title">
        <span className="wb-block-symbol" aria-hidden="true">
          {symbol}
        </span>
        <strong title={data.label}>{data.label}</strong>
        {editor && kind !== 'start' && (
          <button
            type="button"
            className="wb-remove-block nodrag nopan"
            disabled={editor.locked || data.locked}
            aria-label={`Remove ${data.label} from workflow`}
            title="Remove from workflow"
            onClick={(event) => {
              event.stopPropagation();
              editor.removeBlock(id);
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />
            </svg>
          </button>
        )}
      </div>
      <div className="wb-block-subtitle" title={data.subtitle}>
        {data.subtitle}
      </div>
      {editor && capabilityCard ? (
        <div className="wb-capability-columns nopan" onKeyDown={(event) => event.stopPropagation()}>
          <section className="wb-card-inputs" aria-label={`${data.label} inputs`}>
            <h4>
              Inputs <span aria-hidden="true">→</span>
            </h4>
            <StepFields
              document={editor.document}
              step={step}
              capabilities={editor.capabilities}
              disabled={editor.locked}
              inline
              section="inputs"
              onChange={(update) => editor.commit(updateBuilderStep(editor.document, id, update))}
            />
          </section>
          <section className="wb-card-controls" aria-label={`${data.label} settings`}>
            <h4>Settings</h4>
            <label>
              Name
              <input
                className="nodrag"
                disabled={editor.locked}
                value={editor.document.labels[id] ?? ''}
                placeholder={data.label}
                onChange={(event) =>
                  editor.commit({
                    ...editor.document,
                    labels: { ...editor.document.labels, [id]: event.target.value },
                  })
                }
              />
            </label>
            <StepFields
              document={editor.document}
              step={step}
              capabilities={editor.capabilities}
              disabled={editor.locked}
              section="summary"
              onChange={(update) => editor.commit(updateBuilderStep(editor.document, id, update))}
            />
            <p className="wb-help">Click the card for all settings.</p>
          </section>
          <section className="wb-card-outputs" aria-label={`${data.label} outputs`}>
            <h4>
              Outputs <span aria-hidden="true">→</span>
            </h4>
            <p className="wb-help">
              Fields returned by this capability, available as inputs to later steps.
            </p>
            <div className="wb-output-fields wb-block-outputs">
              {Object.entries(outputSchema.required).map(([name, field]) => (
                <div key={name}>
                  <code>{name}</code>
                  <small>{field.type}</small>
                </div>
              ))}
            </div>
            {!Object.keys(outputSchema.required).length && (
              <p className="wb-help">No output fields defined.</p>
            )}
            <details>
              <summary className="nodrag">Edit output fields</summary>
              <BuilderSchemaField
                label="Output fields"
                schema={outputSchema}
                disabled={editor.locked}
                onChange={(responseSchema) =>
                  editor.commit(updateBuilderStep(editor.document, id, { responseSchema }))
                }
              />
            </details>
          </section>
        </div>
      ) : (
        editor &&
        kind !== 'note' && (
          <>
            <div className="wb-inline-fields nopan" onKeyDown={(event) => event.stopPropagation()}>
              {kind === 'start' ? (
                <StartFields
                  document={editor.document}
                  disabled={editor.locked}
                  onChange={editor.commit}
                />
              ) : step && !data.locked ? (
                <StepFields
                  document={editor.document}
                  step={step}
                  capabilities={editor.capabilities}
                  disabled={editor.locked}
                  inline
                  onChange={(update) =>
                    editor.commit(updateBuilderStep(editor.document, id, update))
                  }
                />
              ) : (
                <p className="wb-help">This step is preserved. Open settings to inspect it.</p>
              )}
            </div>
            {Object.keys(outputSchema.required).length > 0 && (
              <div className="wb-block-outputs">
                <span>Outputs</span>
                {Object.entries(outputSchema.required).map(([name, field]) => (
                  <code key={name} title={`${name} (${field.type})`}>
                    {name}
                  </code>
                ))}
              </div>
            )}
          </>
        )
      )}
      <div className="wb-block-badges">
        {data.lastKnownDefinition && (
          <span className="wb-definition-badge">Last known definition</span>
        )}
        {data.issueCount > 0 && (
          <span className="wb-issue-badge">
            {data.issueCount} {data.issueCount === 1 ? 'issue' : 'issues'}
          </span>
        )}
        {data.status && <span className="wb-status-badge">{data.status}</span>}
        {data.locked && <span className="wb-status-badge">Preserved</span>}
      </div>
      {!noConnection &&
        kind !== 'terminal' &&
        (kind === 'condition' ? (
          <div className="wb-branch-labels">
            <div>
              If true
              <Handle type="source" position={Position.Right} id="whenTrue" />
            </div>
            <div>
              Otherwise
              <Handle type="source" position={Position.Right} id="whenFalse" />
            </div>
          </div>
        ) : (
          <Handle type="source" position={Position.Right} id="next" />
        ))}
    </div>
  );
}

const nodeTypes = { block: WorkflowBlock };
const noIssues: readonly BuilderIssue[] = [];
const noStatus: Readonly<Record<string, string>> = {};

function graphNodes(
  document: BuilderDocument,
  issues: readonly BuilderIssue[],
  status: Readonly<Record<string, string>>,
  capabilities: readonly BuilderCapability[],
): BlockNode[] {
  const blocks = [{ id: BUILDER_START_ID, kind: 'start' }, ...builderSteps(document)];
  const defaultLayout = arrangeBuilder(document).layout;
  return [
    ...blocks.map((step, index): BlockNode => {
      const title =
        step.kind === 'start' ? 'Start' : builderStepLabel(document, step, capabilities);
      const capabilityId = builderObject(step).capabilityVersionId;
      const capability = capabilities.find((entry) => entry.capabilityVersionId === capabilityId);
      const duration = builderObject(step).durationMs;
      const subtitle =
        step.kind === 'start'
          ? document.trigger.type === 'webhook'
            ? 'On webhook'
            : 'Manual / API'
          : step.kind === 'sleep'
            ? `${Number(duration) / 1000} seconds`
            : step.kind === 'terminal'
              ? builderText(builderObject(step).state, 'completed').replaceAll('_', ' ')
              : typeof capabilityId === 'string'
                ? capabilityId
                  ? capability?.label && title !== capability.label
                    ? capability.label
                    : capability?.description || 'Map inputs from Start or earlier steps.'
                  : 'Choose a capability'
                : step.kind === 'transform'
                  ? `${Object.keys(builderObject(builderObject(step).arguments)).length} fields`
                  : step.kind === 'condition'
                    ? 'Choose one path'
                    : step.kind === 'compensation'
                      ? `Undo ${builderText(builderObject(step).compensatesStepId)}`
                      : title;
      return {
        id: step.id,
        type: 'block',
        position: document.layout[step.id] ??
          defaultLayout[step.id] ?? { x: index * 920 + 45, y: 80 },
        data: {
          label: title,
          kind: step.kind,
          subtitle,
          issueCount: issues.filter((issue) => issue.stepId === step.id).length,
          locked: step.kind !== 'start' && !builderStepEditable(step),
          lastKnownDefinition: usesLastKnownDefinition(capability?.observation),
          ...(status[step.id] ? { status: status[step.id] } : {}),
        },
        deletable: step.id !== BUILDER_START_ID,
        width: builderBlockWidth(step),
      };
    }),
    ...document.notes.map(
      (note): BlockNode => ({
        id: note.id,
        type: 'block',
        position: { x: note.x, y: note.y },
        data: { label: 'Note', kind: 'note', subtitle: note.text, issueCount: 0, locked: false },
        width: 360,
      }),
    ),
  ];
}

function graphEdges(document: BuilderDocument): Edge[] {
  return builderConnections(document).map((edge) => ({
    id: `${edge.source}:${edge.port}`,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.port,
    targetHandle: 'in',
    label:
      edge.port === 'whenTrue' ? 'If true' : edge.port === 'whenFalse' ? 'Otherwise' : undefined,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { strokeWidth: 1.5 },
  }));
}

export function WorkflowBuilder(props: WorkflowBuilderProps) {
  return (
    <ReactFlowProvider>
      <WorkflowBuilderCanvas {...props} />
    </ReactFlowProvider>
  );
}

function WorkflowBuilderCanvas({
  document,
  onChange,
  capabilities,
  disabled = false,
  readOnly = false,
  issues: externalIssues = noIssues,
  status = noStatus,
}: WorkflowBuilderProps) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(BUILDER_START_ID);
  const [selectedEdge, setSelectedEdge] = useState<BuilderConnection>();
  const [announcement, setAnnouncement] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = settingsRef.current;
    if (!dialog) return;
    if (settingsOpen && !dialog.open) dialog.showModal();
    else if (!settingsOpen && dialog.open) dialog.close();
  }, [settingsOpen]);
  const [history, setHistory] = useState<{ past: BuilderDocument[]; future: BuilderDocument[] }>({
    past: [],
    future: [],
  });
  const lastEmitted = useRef(document);
  const reason = builderReadOnlyReason(document);
  const locked = disabled || readOnly || !!reason;
  const issues = useMemo(
    () => [...builderIssues(document), ...externalIssues],
    [document, externalIssues],
  );
  const generatedNodes = useMemo(
    () => graphNodes(document, issues, status, capabilities),
    [document, issues, status, capabilities],
  );
  const [nodes, setNodes] = useState<BlockNode[]>(generatedNodes);
  const edges = useMemo(() => graphEdges(document), [document]);
  const selectedNodes = useMemo(
    () => nodes.map((node) => ({ ...node, selected: node.id === selectedId })),
    [nodes, selectedId],
  );
  const selectedEdges = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        selected: edge.source === selectedEdge?.source && edge.sourceHandle === selectedEdge.port,
      })),
    [edges, selectedEdge],
  );
  const flow = useReactFlow<BlockNode>();
  const steps = builderSteps(document);
  const step = steps.find(({ id }) => id === selectedId);
  const note = document.notes.find(({ id }) => id === selectedId);
  // XYFlow calls this from an effect. A new callback can replay its previous selection
  // while controlled nodes are updating and keep switching the selected step.
  const onSelectionChange = useCallback(({ nodes }: { nodes: BlockNode[] }) => {
    if (nodes.length === 1 && nodes[0]) setSelectedId(nodes[0].id);
  }, []);

  useEffect(() => {
    setNodes(generatedNodes);
  }, [generatedNodes]);
  useEffect(() => {
    if (lastEmitted.current !== document) {
      const previous = lastEmitted.current;
      setHistory((history) => ({ past: [...history.past.slice(-49), previous], future: [] }));
      lastEmitted.current = document;
    }
  }, [document]);

  const commit = useCallback(
    (next: BuilderDocument, message?: string) => {
      if (locked || next === document) return;
      setHistory((history) => ({ past: [...history.past.slice(-49), document], future: [] }));
      lastEmitted.current = next;
      onChange(next);
      if (message) setAnnouncement(message);
    },
    [document, locked, onChange],
  );

  function travel(direction: 'undo' | 'redo') {
    if (locked) return;
    const next = direction === 'undo' ? history.past.at(-1) : history.future[0];
    if (!next) return;
    setHistory(
      direction === 'undo'
        ? { past: history.past.slice(0, -1), future: [document, ...history.future] }
        : { past: [...history.past, document], future: history.future.slice(1) },
    );
    lastEmitted.current = next;
    onChange(next);
    setAnnouncement(direction === 'undo' ? 'Change undone.' : 'Change restored.');
  }

  function add(kind: BuilderBlockKind, position?: { x: number; y: number }) {
    const added = addBuilderBlock(document, kind, selectedEdge);
    if (position)
      added.document =
        kind === 'note'
          ? {
              ...added.document,
              notes: added.document.notes.map((note) =>
                note.id === added.id ? { ...note, ...position } : note,
              ),
            }
          : { ...added.document, layout: { ...added.document.layout, [added.id]: position } };
    commit(added.document, `${palette.find((item) => item.kind === kind)?.title ?? 'Step'} added.`);
    setSelectedId(added.id);
    setSelectedEdge(undefined);
    if (!position) {
      const point =
        added.document.layout[added.id] ??
        added.document.notes.find((note) => note.id === added.id);
      if (point)
        requestAnimationFrame(
          () =>
            void flow.setCenter(point.x + builderBlockWidth({ kind }) / 2, point.y + 350, {
              zoom: 1,
              duration: 250,
            }),
        );
    }
  }

  function connectionFromFlow(connection: Connection | Edge): BuilderConnection {
    return {
      source: connection.source,
      target: connection.target,
      port: connection.sourceHandle ?? 'next',
    };
  }

  const onNodesChange: OnNodesChange<BlockNode> = useCallback(
    (changes) => {
      const selection = changes.find((change) => change.type === 'select' && change.selected);
      if (selection?.type === 'select') {
        setSelectedId(selection.id);
        setSelectedEdge(undefined);
      }
      setNodes((nodes) =>
        applyNodeChanges(
          changes.filter((change) => change.type !== 'remove'),
          nodes,
        ),
      );
      let next = document;
      for (const change of changes) {
        if (change.type !== 'position' || change.dragging !== false || !change.position) continue;
        const position = change.position;
        if (next.notes.some(({ id }) => id === change.id))
          next = {
            ...next,
            notes: next.notes.map((note) =>
              note.id === change.id ? { ...note, ...position } : note,
            ),
          };
        else next = { ...next, layout: { ...next.layout, [change.id]: position } };
      }
      if (next !== document) commit(next);
    },
    [document, commit],
  );

  const currentStepLocked = locked || (step !== undefined && !builderStepEditable(step));
  function openSettings(id = selectedId) {
    setSelectedId(id);
    setSelectedEdge(undefined);
    setSettingsOpen(true);
  }
  function removeBlock(id: string) {
    const target = steps.find((step) => step.id === id);
    if (locked || id === BUILDER_START_ID || (target && !builderStepEditable(target))) return;
    commit(
      removeBuilderBlocks(document, [id]),
      'Step removed from this workflow. Undo to restore it. Check any inputs that used its output.',
    );
    setSelectedId(BUILDER_START_ID);
    setSelectedEdge(undefined);
    setSettingsOpen(false);
  }
  return (
    <BlockEditorContext.Provider
      value={{ document, capabilities, locked, commit, openSettings, removeBlock }}
    >
      <section
        className="wb-root"
        aria-label="Manual workflow builder"
        aria-busy={disabled || undefined}
        onKeyDown={(event) => {
          const target = event.target;
          if (
            target instanceof HTMLElement &&
            (target.matches('input,textarea,select') || target.isContentEditable)
          )
            return;
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            travel(event.shiftKey ? 'redo' : 'undo');
          }
        }}
      >
        <header className="wb-toolbar">
          <div>
            <strong>Workflow builder</strong>
            <span>{steps.filter((step) => step.kind !== 'compensation').length} steps</span>
          </div>
          <div className="wb-toolbar-actions">
            <button
              className="nodrag"
              type="button"
              disabled={locked || !history.past.length}
              onClick={() => travel('undo')}
              title="Undo (Ctrl+Z)"
            >
              Undo
            </button>
            <button
              className="nodrag"
              type="button"
              disabled={locked || !history.future.length}
              onClick={() => travel('redo')}
              title="Redo (Ctrl+Shift+Z)"
            >
              Redo
            </button>
            <button
              className="nodrag"
              type="button"
              disabled={locked}
              onClick={() => {
                commit(arrangeBuilder(document), 'Steps arranged.');
                requestAnimationFrame(() => void flow.fitView({ padding: 0.15 }));
              }}
            >
              Arrange
            </button>
            <button
              className="nodrag"
              type="button"
              onClick={() => void flow.fitView({ padding: 0.15 })}
            >
              Fit to view
            </button>
          </div>
        </header>
        {reason && (
          <p className="wb-notice" role="status">
            {reason}
          </p>
        )}
        <div className="wb-workspace">
          <aside className="wb-palette" aria-label="Add workflow blocks">
            <h3>Building blocks</h3>
            <input
              className="nodrag"
              aria-label="Find a block"
              type="search"
              placeholder="Find a block…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <p className="wb-help">Click to add, or drag onto the canvas.</p>
            {palette
              .filter((entry) =>
                `${entry.title} ${entry.description}`.toLowerCase().includes(search.toLowerCase()),
              )
              .map((entry) => (
                <button
                  type="button"
                  className="wb-palette-block nodrag"
                  key={entry.kind}
                  disabled={locked}
                  draggable={!locked}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/atlas-workflow-block', entry.kind);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => add(entry.kind)}
                >
                  <span aria-hidden="true">{entry.symbol}</span>
                  <span>
                    <strong>{entry.title}</strong>
                    <small>{entry.description}</small>
                  </span>
                </button>
              ))}
            <div className="wb-palette-note">
              <strong>Built around your capabilities</strong>
              <p>Connect steps to choose their order. Map inputs directly inside each block.</p>
            </div>
          </aside>
          <div
            className="wb-canvas"
            aria-label="Workflow canvas"
            onDragOver={(event) => {
              if (!locked) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDrop={(event) => {
              if (locked) return;
              event.preventDefault();
              const kind = event.dataTransfer.getData('application/atlas-workflow-block');
              if (palette.some((entry) => entry.kind === kind))
                add(
                  kind as BuilderBlockKind,
                  flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
                );
            }}
          >
            <ReactFlow<BlockNode>
              nodes={selectedNodes}
              edges={selectedEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={(changes) => {
                const selection = changes.find(
                  (change) => change.type === 'select' && change.selected,
                );
                const edge =
                  selection?.type === 'select'
                    ? edges.find(({ id }) => id === selection.id)
                    : undefined;
                if (edge) {
                  setSelectedEdge({
                    source: edge.source,
                    target: edge.target,
                    port: edge.sourceHandle ?? 'next',
                  });
                  setSelectedId('');
                }
              }}
              nodesDraggable={!locked}
              nodesConnectable={!locked}
              edgesReconnectable={!locked}
              deleteKeyCode={locked || settingsOpen ? null : ['Backspace', 'Delete']}
              onDelete={({ nodes: removedNodes, edges: removedEdges }) => {
                let next = removeBuilderBlocks(
                  document,
                  removedNodes.map(({ id }) => id),
                );
                for (const edge of removedEdges)
                  next = disconnectBuilder(next, edge.source, edge.sourceHandle ?? 'next');
                commit(next, 'Selection removed. Check any inputs that used its output.');
                setSelectedId(BUILDER_START_ID);
                setSelectedEdge(undefined);
              }}
              onConnect={(connection) =>
                commit(connectBuilder(document, connectionFromFlow(connection)), 'Steps connected.')
              }
              onReconnect={(edge, connection) => {
                const without = disconnectBuilder(
                  document,
                  edge.source,
                  edge.sourceHandle ?? 'next',
                );
                const candidate = connectionFromFlow(connection);
                if (builderConnectionAllowed(without, candidate))
                  commit(connectBuilder(without, candidate), 'Connection changed.');
              }}
              isValidConnection={(connection) =>
                !locked && builderConnectionAllowed(document, connectionFromFlow(connection))
              }
              onNodeClick={(_event, node) => {
                setSelectedId(node.id);
                setSelectedEdge(undefined);
              }}
              onEdgeClick={(_event, edge) => {
                setSettingsOpen(true);
                setSelectedEdge({
                  source: edge.source,
                  target: edge.target,
                  port: edge.sourceHandle ?? 'next',
                });
                setSelectedId('');
              }}
              onSelectionChange={onSelectionChange}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
              panOnScroll={false}
              zoomOnScroll
              zoomOnPinch
              minZoom={0.2}
              maxZoom={1.8}
              nodesFocusable
              edgesFocusable
            >
              <Background gap={22} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
            {steps.length === 1 && !steps.some((step) => step.kind !== 'terminal') && (
              <p className="wb-canvas-hint">
                Add a capability, then connect Start → Capability → Finish.
              </p>
            )}
          </div>
          <dialog
            ref={settingsRef}
            className="wb-settings wb-settings-dialog"
            aria-label="Block settings"
            onCancel={() => setSettingsOpen(false)}
            onClose={() => setSettingsOpen(false)}
            onClick={(event) => {
              if (event.target !== event.currentTarget) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              if (
                event.clientX < bounds.left ||
                event.clientX > bounds.right ||
                event.clientY < bounds.top ||
                event.clientY > bounds.bottom
              )
                setSettingsOpen(false);
            }}
          >
            <button
              type="button"
              className="wb-close-settings nodrag"
              aria-label="Close settings"
              title="Close settings"
              onClick={() => setSettingsOpen(false)}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
            {selectedEdge ? (
              <>
                <h3>Connection</h3>
                <p className="wb-help">Insert a step between these two blocks.</p>
                <select
                  className="nodrag"
                  aria-label="Insert a step"
                  disabled={locked}
                  value=""
                  onChange={(event) => {
                    if (event.target.value) add(event.target.value as BuilderBlockKind);
                  }}
                >
                  <option value="">Choose a block…</option>
                  {palette
                    .filter((entry) => entry.kind !== 'note' && entry.kind !== 'terminal')
                    .map((entry) => (
                      <option value={entry.kind} key={entry.kind}>
                        {entry.title}
                      </option>
                    ))}
                </select>
                <button
                  className="nodrag"
                  type="button"
                  disabled={locked}
                  onClick={() => {
                    commit(disconnectBuilder(document, selectedEdge.source, selectedEdge.port));
                    setSelectedEdge(undefined);
                  }}
                >
                  Remove connection
                </button>
              </>
            ) : selectedId === BUILDER_START_ID ? (
              <>
                <h3>Start</h3>
                <p className="wb-help">Choose how a run begins and the values it receives.</p>
                <label htmlFor="wb-trigger">Start method</label>
                <select
                  className="nodrag"
                  id="wb-trigger"
                  disabled={locked}
                  value={document.trigger.type}
                  onChange={(event) =>
                    commit({
                      ...document,
                      trigger: { type: event.target.value === 'webhook' ? 'webhook' : 'manual' },
                    })
                  }
                >
                  <option value="manual">Manual / API</option>
                  <option value="webhook">Webhook</option>
                </select>
                {document.trigger.type === 'webhook' && (
                  <p className="wb-help">
                    Each accepted webhook starts a new run. Endpoint access is configured when the
                    workflow is activated.
                  </p>
                )}
                <BuilderSchemaField
                  schema={builderSchema(builderObject(document.executable).inputSchema)}
                  disabled={locked}
                  onChange={(inputSchema) =>
                    commit({
                      ...document,
                      executable: { ...builderObject(document.executable), inputSchema },
                    })
                  }
                />
                <NextFields
                  document={document}
                  stepId={BUILDER_START_ID}
                  capabilities={capabilities}
                  disabled={locked}
                  onChange={commit}
                />
              </>
            ) : note ? (
              <>
                <h3>Note</h3>
                <label htmlFor="wb-note">Text</label>
                <textarea
                  className="nodrag"
                  id="wb-note"
                  disabled={locked}
                  rows={7}
                  value={note.text}
                  onChange={(event) =>
                    commit({
                      ...document,
                      notes: document.notes.map((note) =>
                        note.id === selectedId ? { ...note, text: event.target.value } : note,
                      ),
                    })
                  }
                />
              </>
            ) : step ? (
              <>
                <div className="wb-settings-heading">
                  <h3>{builderStepLabel(document, step, capabilities)}</h3>
                  <small>{step.id}</small>
                </div>
                <label htmlFor="wb-label">Name</label>
                <input
                  className="nodrag"
                  id="wb-label"
                  disabled={currentStepLocked}
                  value={document.labels[step.id] ?? ''}
                  placeholder={builderStepLabel({ ...document, labels: {} }, step, capabilities)}
                  onChange={(event) =>
                    commit({
                      ...document,
                      labels: { ...document.labels, [step.id]: event.target.value },
                    })
                  }
                />
                <StepFields
                  key={step.id}
                  document={document}
                  step={step}
                  capabilities={capabilities}
                  disabled={currentStepLocked}
                  onChange={(update) => commit(updateBuilderStep(document, step.id, update))}
                />
                {builderStepEditable(step) &&
                  step.kind !== 'terminal' &&
                  step.kind !== 'compensation' && (
                    <NextFields
                      document={document}
                      stepId={step.id}
                      capabilities={capabilities}
                      disabled={locked}
                      onChange={commit}
                    />
                  )}
              </>
            ) : (
              <>
                <h3>Step settings</h3>
                <p className="wb-help">Select a step or connection to edit it.</p>
              </>
            )}
            {(step || note) && (
              <div className="wb-step-actions">
                <button
                  className="nodrag"
                  type="button"
                  disabled={currentStepLocked || step?.kind === 'compensation'}
                  onClick={() => {
                    const duplicate = duplicateBuilderBlock(document, selectedId, capabilities);
                    if (duplicate) {
                      commit(duplicate.document, 'Step duplicated. Connect it to use it.');
                      setSelectedId(duplicate.id);
                    }
                  }}
                >
                  Duplicate
                </button>
                <button
                  className="nodrag"
                  type="button"
                  disabled={currentStepLocked}
                  onClick={() => removeBlock(selectedId)}
                >
                  Remove from workflow
                </button>
              </div>
            )}
            {issues.some((issue) => issue.stepId === selectedId) && (
              <div className="wb-local-issues">
                <h4>Needs attention</h4>
                {issues
                  .filter((issue) => issue.stepId === selectedId)
                  .map((issue, index) => (
                    <p key={index}>{issue.message}</p>
                  ))}
              </div>
            )}
          </dialog>
        </div>
        <footer className="wb-footer">
          <span>
            {readOnly
              ? 'Read only'
              : issues.length
                ? `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'} to review`
                : 'Ready for workflow checks'}
          </span>
          <span>Connect by dragging between dots, or use “Next step” in settings.</span>
        </footer>
        <span className="wb-sr-only" role="status" aria-live="polite">
          {announcement}
        </span>
      </section>
    </BlockEditorContext.Provider>
  );
}

function NextFields({
  document,
  stepId,
  capabilities,
  disabled,
  onChange,
}: {
  document: BuilderDocument;
  stepId: string;
  capabilities: readonly BuilderCapability[];
  disabled: boolean;
  onChange: (document: BuilderDocument) => void;
}) {
  const step = builderSteps(document).find(({ id }) => id === stepId);
  const ports = step?.kind === 'condition' ? ['whenTrue', 'whenFalse'] : ['next'];
  return (
    <div className="wb-next-fields">
      {ports.map((port) => {
        const value =
          stepId === BUILDER_START_ID
            ? builderObject(document.executable).startStepId
            : step?.[port];
        return (
          <label key={port}>
            {port === 'whenTrue' ? 'If true' : port === 'whenFalse' ? 'Otherwise' : 'Next step'}
            <select
              className="nodrag"
              aria-label={
                port === 'whenTrue'
                  ? 'If true next step'
                  : port === 'whenFalse'
                    ? 'Otherwise next step'
                    : 'Next step'
              }
              disabled={disabled}
              value={typeof value === 'string' ? value : ''}
              onChange={(event) =>
                onChange(
                  event.target.value
                    ? connectBuilder(document, { source: stepId, target: event.target.value, port })
                    : disconnectBuilder(document, stepId, port),
                )
              }
            >
              <option value="">Not connected</option>
              {builderSteps(document)
                .filter((target) =>
                  builderConnectionAllowed(document, { source: stepId, target: target.id, port }),
                )
                .map((target) => (
                  <option key={target.id} value={target.id}>
                    {builderStepLabel(document, target, capabilities)} · {target.id}
                  </option>
                ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}

function StepFields({
  document,
  step,
  capabilities,
  disabled,
  onChange,
  inline = false,
  section = 'all',
}: {
  document: BuilderDocument;
  step: BuilderStep;
  capabilities: readonly BuilderCapability[];
  disabled: boolean;
  onChange: (update: Record<string, unknown>) => void;
  inline?: boolean;
  section?: 'all' | 'inputs' | 'settings' | 'summary';
}) {
  const fieldId = useId();
  const options = builderValueOptions(document, step.id, capabilities);
  const [fieldName, setFieldName] = useState('');
  const [durationUnit, setDurationUnit] = useState(60_000);
  const [durationText, setDurationText] = useState<string>();
  if (!builderStepEditable(step))
    return (
      <>
        <p className="wb-help">This step is preserved exactly. Edit it in the source view.</p>
        <pre className="wb-preserved">{JSON.stringify(step, null, 2)}</pre>
      </>
    );
  const capabilityStep = ['capabilityCall', 'publishEvent', 'notify', 'compensation'].includes(
    step.kind,
  );
  const args = builderObject(step.arguments);
  const schema = builderSchema(step.kind === 'transform' ? step.responseSchema : step.inputSchema);
  const condition = builderObject(step.condition);
  const fields = [...new Set([...Object.keys(schema.required), ...Object.keys(args)])];
  const advanced = Object.fromEntries(
    Object.entries(step).filter(
      ([key]) =>
        ![
          'id',
          'kind',
          'capabilityVersionId',
          'arguments',
          'inputSchema',
          'responseSchema',
          'next',
          'whenTrue',
          'whenFalse',
          'condition',
          'durationMs',
          'state',
          'output',
        ].includes(key),
    ),
  );
  return (
    <>
      {capabilityStep && section !== 'inputs' && (!inline || !step.capabilityVersionId) && (
        <BuilderCapabilityField
          disabled={disabled}
          capabilityVersionId={builderText(step.capabilityVersionId)}
          capabilities={capabilities}
          onSelect={(capability) => {
            onChange({
              capabilityVersionId: capability.capabilityVersionId,
              kind: step.kind === 'compensation' ? step.kind : capability.kind,
              inputSchema: capability.inputSchema,
              responseSchema: capability.responseSchema,
              arguments: {
                ...Object.fromEntries(
                  Object.entries(args).filter(
                    ([field]) => field in capability.inputSchema.required,
                  ),
                ),
                ...(capability.inputSchema.required.atlasWorkflowRunId
                  ? { atlasWorkflowRunId: { source: 'input', path: ['atlasWorkflowRunId'] } }
                  : {}),
              },
            });
          }}
        />
      )}
      {(section === 'all' || section === 'inputs') &&
        (capabilityStep || step.kind === 'transform') && (
          <>
            {section === 'all' && (
              <h4>{step.kind === 'transform' ? 'Fields to create' : 'Input mappings'}</h4>
            )}
            {!fields.length && (
              <p className="wb-help">
                {step.capabilityVersionId
                  ? 'No input mappings required.'
                  : 'Choose a capability in Settings to see its inputs.'}
              </p>
            )}
            {fields.map((field) => (
              <div className="wb-mapping" key={field}>
                <BuilderExpressionField
                  label={field}
                  value={args[field]}
                  options={options}
                  disabled={disabled}
                  {...(schema.required[field]?.type
                    ? { expectedType: schema.required[field]?.type }
                    : {})}
                  allowTransform={!inline}
                  onChange={(value) => onChange({ arguments: { ...args, [field]: value } })}
                />
                {step.kind === 'transform' && (
                  <button
                    type="button"
                    className="wb-text-button nodrag"
                    disabled={disabled}
                    onClick={() =>
                      onChange({
                        arguments: Object.fromEntries(
                          Object.entries(args).filter(([name]) => name !== field),
                        ),
                        responseSchema: {
                          required: Object.fromEntries(
                            Object.entries(schema.required).filter(([name]) => name !== field),
                          ),
                        },
                      })
                    }
                  >
                    Remove field
                  </button>
                )}
              </div>
            ))}
            {step.kind === 'transform' && (
              <>
                <div className="wb-add-field">
                  <input
                    className="nodrag"
                    aria-label="New output field name"
                    placeholder="New field name"
                    disabled={disabled}
                    value={fieldName}
                    onChange={(event) => setFieldName(event.target.value)}
                  />
                  <button
                    className="nodrag"
                    type="button"
                    disabled={
                      disabled || !fieldName.trim() || Object.hasOwn(args, fieldName.trim())
                    }
                    onClick={() => {
                      const name = fieldName.trim();
                      onChange({
                        arguments: { ...args, [name]: { source: 'literal', value: '' } },
                        responseSchema: {
                          required: { ...schema.required, [name]: { type: 'string' } },
                        },
                      });
                      setFieldName('');
                    }}
                  >
                    Add field
                  </button>
                </div>
                <BuilderSchemaField
                  label="Output types"
                  schema={schema}
                  disabled={disabled}
                  onChange={(responseSchema) => onChange({ responseSchema })}
                />
              </>
            )}
            {capabilityStep && !inline && (
              <details>
                <summary className="nodrag">Input and output types</summary>
                <BuilderJsonField
                  label="Input schema"
                  value={step.inputSchema ?? { required: {} }}
                  disabled={disabled}
                  onChange={(inputSchema) => onChange({ inputSchema })}
                />
                <BuilderJsonField
                  label="Output schema"
                  value={step.responseSchema ?? { required: {} }}
                  disabled={disabled}
                  onChange={(responseSchema) => onChange({ responseSchema })}
                />
              </details>
            )}
          </>
        )}
      {step.kind === 'condition' && (
        <>
          <BuilderExpressionField
            label="Value to check"
            value={condition.left}
            options={options}
            disabled={disabled}
            onChange={(left) => onChange({ condition: { ...condition, left } })}
          />
          <label htmlFor={`${fieldId}-operator`}>Rule</label>
          <select
            className="nodrag"
            id={`${fieldId}-operator`}
            disabled={disabled}
            value={builderText(condition.operator, 'equals')}
            onChange={(event) =>
              onChange({ condition: { ...condition, operator: event.target.value } })
            }
          >
            <option value="equals">Equals</option>
            <option value="notEquals">Does not equal</option>
            <option value="greaterThan">Greater than</option>
            <option value="lessThan">Less than</option>
            <option value="exists">Has a value</option>
          </select>
          {condition.operator !== 'exists' && (
            <BuilderExpressionField
              label="Compare with"
              value={condition.right}
              options={options}
              disabled={disabled}
              onChange={(right) => onChange({ condition: { ...condition, right } })}
            />
          )}
        </>
      )}
      {step.kind === 'sleep' && (
        <>
          <label htmlFor={`${fieldId}-duration`}>Wait for</label>
          <div className="wb-duration">
            <input
              className="nodrag"
              id={`${fieldId}-duration`}
              type="number"
              min={1 / durationUnit}
              step="any"
              disabled={disabled}
              value={durationText ?? Number(step.durationMs ?? 0) / durationUnit}
              onChange={(event) => {
                setDurationText(event.target.value);
                if (event.target.value !== '')
                  onChange({ durationMs: Math.round(Number(event.target.value) * durationUnit) });
              }}
              onBlur={() => setDurationText(undefined)}
            />
            <select
              className="nodrag"
              aria-label="Wait unit"
              disabled={disabled}
              value={durationUnit}
              onChange={(event) => {
                setDurationUnit(Number(event.target.value));
                setDurationText(undefined);
              }}
            >
              <option value={1000}>Seconds</option>
              <option value={60_000}>Minutes</option>
              <option value={3_600_000}>Hours</option>
              <option value={86_400_000}>Days</option>
            </select>
          </div>
          <p className="wb-help">
            Up to 30 days. The run resumes after this delay, including after a restart.
          </p>
        </>
      )}
      {step.kind === 'terminal' && (
        <>
          <label htmlFor={`${fieldId}-finish-state`}>Finish as</label>
          <select
            className="nodrag"
            id={`${fieldId}-finish-state`}
            disabled={disabled}
            value={builderText(step.state)}
            onChange={(event) => onChange({ state: event.target.value })}
          >
            {['completed', 'validation_failed', 'manual_review', 'repair_required'].map((state) => (
              <option key={state} value={state}>
                {state.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
          <BuilderExpressionField
            label="Workflow result"
            value={step.output}
            options={options}
            disabled={disabled}
            allowTransform
            onChange={(output) => onChange({ output })}
          />
        </>
      )}
      {capabilityStep && (section === 'all' || section === 'settings') && !inline && (
        <details className="wb-advanced">
          <summary className="nodrag">Retries, error handling, and compensation</summary>
          <p className="wb-help">
            Existing settings are kept when you move, connect, or rename this step. Edit the
            structured settings when needed.
          </p>
          <BuilderJsonField
            label="Advanced settings"
            value={advanced}
            disabled={disabled}
            validate={(value) =>
              value !== null &&
              typeof value === 'object' &&
              !Array.isArray(value) &&
              !Object.keys(builderObject(value)).some((key) =>
                ['id', 'kind', 'arguments', 'next', 'whenTrue', 'whenFalse'].includes(key),
              )
                ? undefined
                : 'Use a settings object without step identifiers, input mappings, or connections.'
            }
            onChange={(value) =>
              onChange({
                ...Object.fromEntries(Object.keys(advanced).map((key) => [key, undefined])),
                ...builderObject(value),
              })
            }
          />
        </details>
      )}
    </>
  );
}
