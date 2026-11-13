import { useState } from 'preact/hooks';
import type { WebviewToHost } from '../protocol';
import { fileIcon, splitPath } from './fileIcon';
import { parseMarkdown, type Block, type Inline } from './markdown';

/**
 * Renders parsed Markdown as Preact elements (never innerHTML), with code-block headers and
 * clickable file and symbol chips. `send` posts to the extension host.
 */

type Send = (msg: WebviewToHost) => void;

export function FileGlyph({ path, size = 14 }: { path: string; size?: number }) {
  const icon = fileIcon(path);
  return (
    <svg
      class="file-glyph"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke={icon.tint} stroke-width="1.2" />
      <path d="M9.5 1.5v3h3" fill="none" stroke={icon.tint} stroke-width="1.2" />
      <rect x="5" y="8" width="6" height="1.4" rx=".7" fill={icon.tint} />
      <rect x="5" y="10.8" width="4" height="1.4" rx=".7" fill={icon.tint} />
    </svg>
  );
}

export function FileChip({
  path,
  line,
  send,
}: {
  path: string;
  line?: number | undefined;
  send: Send;
}) {
  const { name } = splitPath(path);
  const where = line === undefined ? path : `${path}:${line}`;
  return (
    <button
      type="button"
      class="chip"
      title={`Open ${where} (${fileIcon(path).label})`}
      aria-label={`Open ${where}`}
      onClick={() => send({ type: 'openFile', path, ...(line === undefined ? {} : { line }) })}
    >
      <FileGlyph path={path} />
      <span>
        {name}
        {line === undefined ? '' : `:${line}`}
      </span>
    </button>
  );
}

function CodeBlock({
  lang,
  code,
  open,
  send,
}: {
  lang: string;
  code: string;
  open: boolean;
  send: Send;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="codeblock">
      <div class="codeblock-head">
        <span class="codeblock-lang">{lang || 'text'}</span>
        <span class="codeblock-actions">
          <button
            type="button"
            class="icon-button"
            title="Insert at cursor"
            aria-label="Insert at cursor"
            disabled={open}
            onClick={() => send({ type: 'insertCode', text: code })}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" stroke-width="1.3" />
              <path
                d="M10.6 8v1.2a1.9 1.9 0 0 0 3.8 0V8A6.4 6.4 0 1 0 11 13.4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
              />
            </svg>
          </button>
          <button
            type="button"
            class="icon-button"
            title={copied ? 'Copied' : 'Copy'}
            aria-label={copied ? 'Copied' : 'Copy code'}
            onClick={() => {
              send({ type: 'copy', text: code });
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? (
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.6" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <rect
                  x="5"
                  y="5"
                  width="8.5"
                  height="9"
                  rx="1.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                />
                <path
                  d="M3 10.5V3.5A1.5 1.5 0 0 1 4.5 2H10"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                />
              </svg>
            )}
          </button>
        </span>
      </div>
      <pre class="codeblock-body">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Inlines({ nodes, send }: { nodes: readonly Inline[]; send: Send }) {
  return (
    <>
      {nodes.map((n) => {
        switch (n.t) {
          case 'text':
            return n.v;
          case 'strong':
            return (
              <strong>
                <Inlines nodes={n.c} send={send} />
              </strong>
            );
          case 'em':
            return (
              <em>
                <Inlines nodes={n.c} send={send} />
              </em>
            );
          case 'code':
            return <code class="inline-code">{n.v}</code>;
          case 'link':
            return (
              <a href={n.href} title={n.href}>
                <Inlines nodes={n.c} send={send} />
              </a>
            );
          case 'path':
            return <FileChip path={n.path} line={n.line} send={send} />;
          case 'symbol':
            return (
              <button
                type="button"
                class="chip chip-symbol"
                title={`Go to ${n.name}`}
                aria-label={`Go to symbol ${n.name}`}
                onClick={() => send({ type: 'openSymbol', name: n.name })}
              >
                <span aria-hidden="true" class="symbol-mark">
                  ƒ
                </span>
                <span>{n.name}()</span>
              </button>
            );
        }
      })}
    </>
  );
}

function Blocks({ blocks, send }: { blocks: readonly Block[]; send: Send }) {
  return (
    <>
      {blocks.map((b) => {
        switch (b.t) {
          case 'h': {
            const Tag = `h${Math.min(6, b.level + 2)}` as 'h3';
            return (
              <Tag class="md-heading">
                <Inlines nodes={b.c} send={send} />
              </Tag>
            );
          }
          case 'p':
            return (
              <p>
                <Inlines nodes={b.c} send={send} />
              </p>
            );
          case 'list': {
            const items = b.items.map((item) => (
              <li>
                <Blocks blocks={item} send={send} />
              </li>
            ));
            return b.ordered ? <ol start={b.start}>{items}</ol> : <ul>{items}</ul>;
          }
          case 'code':
            return <CodeBlock lang={b.lang} code={b.v} open={b.open} send={send} />;
          case 'table':
            return (
              <div class="md-table-wrap">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((h, k) => (
                        <th style={b.align[k] ? { textAlign: b.align[k] } : undefined}>
                          <Inlines nodes={h} send={send} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r) => (
                      <tr>
                        {r.map((c, k) => (
                          <td style={b.align[k] ? { textAlign: b.align[k] } : undefined}>
                            <Inlines nodes={c} send={send} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'quote':
            return (
              <blockquote>
                <Blocks blocks={b.c} send={send} />
              </blockquote>
            );
          case 'hr':
            return <hr />;
        }
      })}
    </>
  );
}

export function Markdown({ text, send }: { text: string; send: Send }) {
  return (
    <div class="md">
      <Blocks blocks={parseMarkdown(text)} send={send} />
    </div>
  );
}
