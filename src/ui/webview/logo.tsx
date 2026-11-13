/**
 * The Swage mark: a swage block (a forging block with a round groove) and one spark. Original
 * artwork, inlined so the webview needs no image request; the block follows the theme's
 * foreground and the spark keeps Swage's accent colour (media/swage-logo.svg is the same mark).
 */
export function Logo({ size = 20, title }: { size?: number; title?: string }) {
  return (
    <svg
      class="swage-logo"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : 'true'}
      focusable="false"
    >
      <path class="logo-block" d="M4 12H12A4 4 0 0 0 20 12H28V17L24 20V24H27V27H5V24H8V20L4 17Z" />
      <path
        class="logo-spark"
        d="M23 1.5L24.3 4.7L27.5 6L24.3 7.3L23 10.5L21.7 7.3L18.5 6L21.7 4.7Z"
      />
      <circle class="logo-spark" cx="28.2" cy="1.8" r="1.1" />
    </svg>
  );
}
