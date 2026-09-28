import { useState, type ReactNode } from 'react';
import type { CatalogSourceGroup } from './repository-sources.js';

export function RepositorySourceTree({
  sources,
  selectedSourceKey,
  selectedService,
  onSelect,
  children,
}: {
  sources: CatalogSourceGroup[];
  selectedSourceKey: string | null;
  selectedService: string | null;
  onSelect: (sourceKey: string, serviceId: string | null) => void;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const repositoryCount = sources.filter((source) => source.repository).length;
  return (
    <aside className="cat-tree" aria-label="Capability sources">
      <div className="cat-pane-heading">
        <span>Sources</span>
        <strong>
          {repositoryCount} {repositoryCount === 1 ? 'repository' : 'repositories'}
        </strong>
      </div>
      <ul className="cat-repository-tree">
        {sources.map((source) => {
          const selected = selectedSourceKey === source.key;
          const isExpanded =
            (selected && selectedService !== null) || (expanded[source.key] ?? selected);
          const childrenId = `source-services-${encodeURIComponent(source.key)}`;
          return (
            <li key={source.key}>
              <button
                className={
                  selected && !selectedService
                    ? 'cat-tree-repository cat-selected'
                    : 'cat-tree-repository'
                }
                type="button"
                aria-expanded={isExpanded}
                aria-controls={childrenId}
                aria-label={`Select ${source.repository ? 'repository' : 'source'} ${source.label}`}
                aria-current={selected && !selectedService ? 'true' : undefined}
                onClick={() => {
                  setExpanded((current) => ({
                    ...current,
                    [source.key]: selected ? !isExpanded : true,
                  }));
                  onSelect(source.key, null);
                }}
              >
                <span aria-hidden="true" className="cat-source-chevron">
                  {isExpanded ? '▾' : '▸'}
                </span>
                <span className="cat-tree-repository-name">
                  <small>{source.repository ? 'Repository' : 'No repository recorded'}</small>
                  <strong>{source.label}</strong>
                </span>
                <b>{source.capabilities.length}</b>
              </button>
              {isExpanded && (
                <ul
                  className="cat-tree-services"
                  id={childrenId}
                  aria-label={`${source.label} service groups`}
                >
                  {source.services.map((service) => (
                    <li key={service.serviceId}>
                      <button
                        type="button"
                        className={
                          selected && selectedService === service.serviceId
                            ? 'cat-tree-source cat-selected'
                            : 'cat-tree-source'
                        }
                        aria-current={
                          selected && selectedService === service.serviceId ? 'true' : undefined
                        }
                        onClick={() => onSelect(source.key, service.serviceId)}
                      >
                        <span className="cat-monogram" aria-hidden="true">
                          {service.serviceId.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="cat-tree-service-name">
                          <small>Service group</small>
                          <strong>{service.serviceId}</strong>
                        </span>
                        <b>{service.operationCount}</b>
                        {service.annotatedCount < service.operationCount && (
                          <i aria-label="Safety annotations missing" className="cat-warn-dot" />
                        )}
                      </button>
                    </li>
                  ))}
                  {!source.services.length && (
                    <li className="cat-tree-empty">No capabilities yet</li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {children}
    </aside>
  );
}
