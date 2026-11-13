import type { WebviewToHost } from '../protocol';
import { createdFiles } from './changes';
import { splitPath } from './fileIcon';
import { FileGlyph, Markdown } from './richText';
import type { TimelineItem } from './state';

/**
 * Edited-file cards and the Walkthrough card (redesign step 3). Counts always carry their + and
 * - signs, so colour is never the only signal.
 */

type Send = (msg: WebviewToHost) => void;

const VERB = { create: 'Created', modify: 'Edited', delete: 'Deleted' } as const;

export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span class="counts" aria-label={`${added} lines added, ${removed} lines removed`}>
      <span class="count-add">+{added}</span> <span class="count-del">-{removed}</span>
    </span>
  );
}

/** Opens the file, or its diff when the file does not exist on disk yet (a created file). */
function openTarget(path: string, kind: string, send: Send): void {
  send(kind === 'create' ? { type: 'openDiff', path } : { type: 'openFile', path });
}

export function EditCard({
  item,
  send,
}: {
  item: Extract<TimelineItem, { kind: 'edit' }>;
  send: Send;
}) {
  const { name } = splitPath(item.path);
  const verb = VERB[item.fileKind];
  return (
    <div class="edit-card" role="group" aria-label={`${verb} ${item.path}`}>
      <FileGlyph path={item.path} />
      <span class="edit-verb">{verb}</span>
      <button
        type="button"
        class="link file-link"
        title={item.path}
        aria-label={`Open ${item.path}`}
        onClick={() => openTarget(item.path, item.fileKind, send)}
      >
        {name}
      </button>
      <Counts added={item.added} removed={item.removed} />
      <span class="spacer" />
      <button
        type="button"
        class="link open-diff"
        aria-label={`Open diff of ${item.path}`}
        onClick={() => send({ type: 'openDiff', path: item.path })}
      >
        Open diff
      </button>
    </div>
  );
}

export function WalkthroughCard({
  item,
  send,
  onView,
}: {
  item: Extract<TimelineItem, { kind: 'walkthrough' }>;
  send: Send;
  onView: () => void;
}) {
  const created = createdFiles(item.files);
  return (
    <section class="card walkthrough" aria-label="Walkthrough">
      <div class="card-head static">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M2.5 3.5h4l1.5 1.5 1.5-1.5h4v9h-4L8 14l-1.5-1.5h-4z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
          />
        </svg>
        <span class="card-title">Walkthrough</span>
        <span class="spacer" />
        <button type="button" class="link" aria-label="View the files-changed bar" onClick={onView}>
          View
        </button>
      </div>
      <div class="card-body">
        <Markdown text={item.summary} send={send} />
        {created.length > 0 && (
          <>
            <div class="card-subtitle">Created files</div>
            <ol class="created-files">
              {created.map((f) => (
                <li>
                  <FileGlyph path={f.path} />{' '}
                  <button
                    type="button"
                    class="link file-link"
                    aria-label={`Open diff of ${f.path}`}
                    onClick={() => send({ type: 'openDiff', path: f.path })}
                  >
                    {f.path}
                  </button>
                  {f.reason ? <span class="reason"> - {f.reason}</span> : null}
                </li>
              ))}
            </ol>
          </>
        )}
        <div class="card-subtitle">Changed files</div>
        <ul class="walk-files">
          {item.files.map((f) => (
            <li>
              <FileGlyph path={f.path} /> <span class="edit-verb">{VERB[f.kind]}</span>{' '}
              <button
                type="button"
                class="link file-link"
                aria-label={`Open ${f.path}`}
                onClick={() => openTarget(f.path, f.kind, send)}
              >
                {f.path}
              </button>{' '}
              <Counts added={f.added} removed={f.removed} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
