import { useState } from 'react';

import { formatRelativeTime } from '../home/summaries.js';
import type { CapabilityUserAnnotation } from './catalog.js';
import {
  createCapabilityUserAnnotation,
  deleteCapabilityUserAnnotation,
  updateCapabilityUserAnnotation,
} from './data.js';

type Editor = { annotationId: string | null; body: string };

export function CapabilityUserAnnotations({
  annotations,
  bearerToken,
  capabilityIdentityId,
  organizationId,
  onChanged,
}: {
  annotations: readonly CapabilityUserAnnotation[];
  bearerToken: string;
  capabilityIdentityId: string;
  organizationId: string;
  onChanged: () => void;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!editor?.body.trim()) return;
    setSaving(true);
    setFailure(null);
    try {
      if (editor.annotationId) {
        await updateCapabilityUserAnnotation(
          organizationId,
          capabilityIdentityId,
          editor.annotationId,
          editor.body,
          bearerToken,
        );
      } else {
        await createCapabilityUserAnnotation(
          organizationId,
          capabilityIdentityId,
          editor.body,
          bearerToken,
        );
      }
      setEditor(null);
      onChanged();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not save this annotation.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(annotationId: string) {
    setDeletingId(annotationId);
    setFailure(null);
    try {
      await deleteCapabilityUserAnnotation(
        organizationId,
        capabilityIdentityId,
        annotationId,
        bearerToken,
      );
      setConfirmingDeleteId(null);
      onChanged();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not delete this annotation.');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="cat-inspector-section">
      <p className="cat-kicker">Business context</p>
      <p className="cat-drawer-copy">
        Notes added here remain attached to this capability when monitoring finds a new version.
        Atlas also provides them to workflow planning.
      </p>
      {annotations.length === 0 ? (
        <small>No business context has been added yet.</small>
      ) : (
        <ul className="cat-user-annotations">
          {annotations.map((annotation) => (
            <li key={annotation.id}>
              {editor?.annotationId === annotation.id ? (
                <AnnotationEditor
                  editor={editor}
                  onCancel={() => setEditor(null)}
                  onChange={(body) => setEditor({ ...editor, body })}
                  onSave={() => void save()}
                  saving={saving}
                />
              ) : (
                <>
                  <p>{annotation.body}</p>
                  <small>
                    {annotation.updatedAt === annotation.createdAt ? 'Added' : 'Updated'} by{' '}
                    {annotation.updatedBy} · {formatRelativeTime(annotation.updatedAt)}
                  </small>
                  <div className="cat-user-annotation-actions">
                    <button
                      className="cat-secondary"
                      onClick={() => {
                        setFailure(null);
                        setEditor({ annotationId: annotation.id, body: annotation.body });
                      }}
                      type="button"
                    >
                      Edit
                    </button>
                    {confirmingDeleteId === annotation.id ? (
                      <>
                        <button
                          className="cat-secondary cat-danger"
                          disabled={deletingId !== null}
                          onClick={() => void remove(annotation.id)}
                          type="button"
                        >
                          {deletingId === annotation.id ? 'Deleting…' : 'Confirm delete'}
                        </button>
                        <button
                          className="cat-secondary"
                          disabled={deletingId !== null}
                          onClick={() => setConfirmingDeleteId(null)}
                          type="button"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="cat-secondary"
                        onClick={() => setConfirmingDeleteId(annotation.id)}
                        type="button"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {editor?.annotationId === null ? (
        <AnnotationEditor
          editor={editor}
          onCancel={() => setEditor(null)}
          onChange={(body) => setEditor({ ...editor, body })}
          onSave={() => void save()}
          saving={saving}
        />
      ) : (
        <button
          className="cat-secondary"
          disabled={editor !== null}
          onClick={() => {
            setFailure(null);
            setEditor({ annotationId: null, body: '' });
          }}
          type="button"
        >
          Add business context
        </button>
      )}
      {failure && <p role="alert">{failure}</p>}
    </section>
  );
}

function AnnotationEditor({
  editor,
  onCancel,
  onChange,
  onSave,
  saving,
}: {
  editor: Editor;
  onCancel: () => void;
  onChange: (body: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="cat-user-annotation-editor">
      <label>
        <span>Business context</span>
        <textarea
          autoFocus
          maxLength={2000}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Explain how your organization uses this capability…"
          rows={4}
          value={editor.body}
        />
      </label>
      <small>{editor.body.length}/2000 characters</small>
      <div className="cat-user-annotation-actions">
        <button
          className="cat-secondary"
          disabled={saving || !editor.body.trim()}
          onClick={onSave}
          type="button"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="cat-secondary" disabled={saving} onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}
