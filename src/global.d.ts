declare const __APP_VERSION__: string

interface Window {
  __config_p__?: Promise<import('./types').UserConfig | void>
  __theme_p__?: Promise<import('./types').ThemeConfig | void>
}
