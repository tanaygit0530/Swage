/**
 * File-type icons for chips, cards and the files-changed bar: Swage's own simple page glyph,
 * tinted by language family, with a short text label for screen readers and high contrast.
 * Colour is never the only signal: the tooltip and aria label name the file type.
 */

export interface FileIconInfo {
  /** Short type label, for example "Python". */
  readonly label: string;
  /** Tint for the glyph (a CSS colour). */
  readonly tint: string;
}

const FAMILIES: readonly { exts: readonly string[]; label: string; tint: string }[] = [
  { exts: ['py', 'pyi'], label: 'Python', tint: '#4b8bbe' },
  { exts: ['ts', 'tsx', 'mts', 'cts'], label: 'TypeScript', tint: '#3178c6' },
  { exts: ['js', 'jsx', 'mjs', 'cjs'], label: 'JavaScript', tint: '#d4b72c' },
  { exts: ['json', 'jsonc'], label: 'JSON', tint: '#c9a227' },
  { exts: ['md', 'rst', 'txt'], label: 'Text', tint: '#7f8c99' },
  { exts: ['html', 'htm', 'xml', 'vue', 'svelte'], label: 'Markup', tint: '#e06c3c' },
  { exts: ['css', 'scss', 'less'], label: 'Stylesheet', tint: '#8f6ed5' },
  { exts: ['toml', 'yaml', 'yml', 'cfg', 'ini', 'env', 'lock'], label: 'Config', tint: '#6f9a6f' },
  { exts: ['sh', 'bash', 'zsh'], label: 'Shell', tint: '#4fa36b' },
  { exts: ['go'], label: 'Go', tint: '#2fa7c9' },
  { exts: ['rs'], label: 'Rust', tint: '#c26a3d' },
  { exts: ['java', 'kt', 'gradle'], label: 'JVM', tint: '#b0703a' },
  { exts: ['c', 'h', 'cc', 'cpp', 'hpp', 'cs'], label: 'C family', tint: '#5c7fbf' },
  { exts: ['rb'], label: 'Ruby', tint: '#b8423c' },
  { exts: ['sql'], label: 'SQL', tint: '#c27b2f' },
];

export function fileIcon(path: string): FileIconInfo {
  const name = path.split('/').pop() ?? path;
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  const family = FAMILIES.find((f) => f.exts.includes(ext));
  return family ? { label: family.label, tint: family.tint } : { label: 'File', tint: '#8a8f98' };
}

/** The file name and its folder, for rows that show "name  folder/". */
export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { name: path, dir: '' } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}
