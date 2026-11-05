// Harness-only SDK adapter: the shared test double, except Codicon renders Desktop's pinned icon font so project glyphs are the real ones instead of the test adapter's repeated folder fallback.
import { createElement as h } from 'react';
import '@vscode/codicons/dist/codicon.css';
export * from '../tests/sdk.mock.mjs';
export function Codicon({ name, size, className = '', style, ...props }) {
  return h('i', { ...props, 'data-codicon': name, 'aria-hidden': true, className: `codicon codicon-${name} ${className}`.trim(), style: { fontSize: size, ...style } });
}
