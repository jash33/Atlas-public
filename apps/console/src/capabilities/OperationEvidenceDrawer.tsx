import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { RemoteView } from '../shell/RemoteView.js';
import { type DemoRole } from '../shell/session.js';
import { useCapabilityInspection, usePlannerProjection } from './data.js';
import { Inspector, InspectorGroup } from './OperationEvidence.js';

export const defaultDrawerWidth = 620;
export const minimumDrawerWidth = 420;
export const drawerViewportGutter = 72;
export const drawerKeyboardStep = 32;
export const drawerWidthStorageKey = 'atlas.console.capability-drawer-width';

export function maximumDrawerWidth(viewportWidth: number): number {
  return Math.max(minimumDrawerWidth, viewportWidth - drawerViewportGutter);
}

export function clampDrawerWidth(width: number, viewportWidth: number): number {
  return Math.min(Math.max(width, minimumDrawerWidth), maximumDrawerWidth(viewportWidth));
}

export function draggedDrawerWidth(
  startWidth: number,
  startPointerX: number,
  pointerX: number,
  viewportWidth: number,
): number {
  return clampDrawerWidth(startWidth + startPointerX - pointerX, viewportWidth);
}

export function keyboardDrawerWidth(
  width: number,
  key: string,
  viewportWidth: number,
): number | null {
  if (key === 'ArrowLeft') return clampDrawerWidth(width + drawerKeyboardStep, viewportWidth);
  if (key === 'ArrowRight') return clampDrawerWidth(width - drawerKeyboardStep, viewportWidth);
  if (key === 'Home') return minimumDrawerWidth;
  if (key === 'End') return maximumDrawerWidth(viewportWidth);
  return null;
}

export function parseDrawerWidth(value: string | null, viewportWidth: number): number {
  if (value === null) return clampDrawerWidth(defaultDrawerWidth, viewportWidth);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return clampDrawerWidth(defaultDrawerWidth, viewportWidth);
  return clampDrawerWidth(Math.round(parsed), viewportWidth);
}

export function readDrawerWidth(storage: Pick<Storage, 'getItem'>, viewportWidth: number): number {
  try {
    return parseDrawerWidth(storage.getItem(drawerWidthStorageKey), viewportWidth);
  } catch {
    return clampDrawerWidth(defaultDrawerWidth, viewportWidth);
  }
}

export function writeDrawerWidth(storage: Pick<Storage, 'setItem'>, width: number): void {
  try {
    storage.setItem(drawerWidthStorageKey, String(Math.round(width)));
  } catch {
    // Resizing remains usable for this session when persistence is unavailable.
  }
}

export function OperationEvidenceDrawer({
  afterHero,
  capabilityVersionId,
  children,
  environmentId,
  onClose,
  onSelectVersion,
  organizationId,
  role,
  topContent,
}: {
  afterHero?: ReactNode | ((serviceId: string) => ReactNode);
  capabilityVersionId: string;
  children?: ReactNode | ((serviceId: string) => ReactNode);
  environmentId: string;
  onClose: () => void;
  onSelectVersion: (capabilityVersionId: string) => void;
  organizationId: string;
  role: DemoRole;
  topContent?: ReactNode;
}) {
  const inspection = useCapabilityInspection(organizationId, environmentId, capabilityVersionId);
  const plannerProjection = usePlannerProjection(organizationId, environmentId);
  const [drawerWidth, setDrawerWidth] = useState(() =>
    readDrawerWidth(window.localStorage, window.innerWidth),
  );
  const drawerWidthRef = useRef(drawerWidth);
  const drag = useRef<{
    pointerId: number;
    startPointerX: number;
    startWidth: number;
  } | null>(null);
  drawerWidthRef.current = drawerWidth;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    const fitDrawerToViewport = () => {
      setDrawerWidth((current) => clampDrawerWidth(current, window.innerWidth));
    };
    window.addEventListener('resize', fitDrawerToViewport);
    return () => window.removeEventListener('resize', fitDrawerToViewport);
  }, []);

  useEffect(() => {
    return () => writeDrawerWidth(window.localStorage, drawerWidthRef.current);
  }, []);

  const maximumWidth = maximumDrawerWidth(window.innerWidth);
  const drawerStyle = { '--cat-drawer-width': `${drawerWidth}px` } as CSSProperties;

  return (
    <>
      <button
        aria-label="Close operation evidence"
        className="cat-drawer-backdrop"
        onClick={onClose}
        type="button"
      />
      <div
        aria-label="Resize operation details"
        aria-orientation="vertical"
        aria-valuemax={maximumWidth}
        aria-valuemin={minimumDrawerWidth}
        aria-valuenow={drawerWidth}
        className="cat-drawer-resize"
        onKeyDown={(event) => {
          const nextWidth = keyboardDrawerWidth(drawerWidth, event.key, window.innerWidth);
          if (nextWidth === null) return;
          event.preventDefault();
          setDrawerWidth(nextWidth);
          writeDrawerWidth(window.localStorage, nextWidth);
        }}
        onPointerCancel={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          drag.current = null;
          writeDrawerWidth(window.localStorage, drawerWidthRef.current);
        }}
        onPointerDown={(event) => {
          drag.current = {
            pointerId: event.pointerId,
            startPointerX: event.clientX,
            startWidth: drawerWidth,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          setDrawerWidth(
            draggedDrawerWidth(
              drag.current.startWidth,
              drag.current.startPointerX,
              event.clientX,
              window.innerWidth,
            ),
          );
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          writeDrawerWidth(window.localStorage, drawerWidthRef.current);
        }}
        role="separator"
        style={drawerStyle}
        tabIndex={0}
      />
      <aside
        aria-label="Operation evidence"
        aria-modal="true"
        className="cat-inspector cat-inspector-drawer"
        role="dialog"
        style={drawerStyle}
      >
        <div className="cat-drawer-heading">
          <div>
            <span>Operation details</span>
            <small>Business context, availability, and technical details</small>
          </div>
          <button
            aria-label="Close operation evidence"
            className="cat-drawer-close"
            onClick={onClose}
            type="button"
          >
            <span aria-hidden="true" className="cat-drawer-close-icon" />
          </button>
        </div>
        {topContent}
        <RemoteView remote={inspection.remote} reload={inspection.reload}>
          {(detail) => {
            if (!detail) {
              return <p className="cat-empty">Select an operation to inspect its evidence.</p>;
            }
            const serviceId = detail.version.identity.serviceId;
            return (
              <>
                <Inspector
                  key={capabilityVersionId}
                  afterHero={typeof afterHero === 'function' ? afterHero(serviceId) : afterHero}
                  inspection={detail}
                  onApproved={() => {
                    inspection.reload();
                    plannerProjection.reload();
                  }}
                  onAnnotationsChanged={() => {
                    inspection.reload();
                    plannerProjection.reload();
                  }}
                  onSelectVersion={onSelectVersion}
                  organizationId={organizationId}
                  plannerProjection={
                    plannerProjection.remote.status === 'ready'
                      ? plannerProjection.remote.data
                      : null
                  }
                  role={role}
                />
                {children && (
                  <InspectorGroup
                    title="Discovery history"
                    summary="Previous source checks and updates"
                  >
                    {typeof children === 'function' ? children(serviceId) : children}
                  </InspectorGroup>
                )}
              </>
            );
          }}
        </RemoteView>
      </aside>
    </>
  );
}
