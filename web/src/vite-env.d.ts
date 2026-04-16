/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME?: string
  readonly VITE_APP_URL?: string
  readonly VITE_APP_DOMAIN?: string
  readonly VITE_SUPPORT_EMAIL?: string
  readonly VITE_CONTACT_EMAIL?: string
  readonly VITE_APP_VERSION?: string
  readonly VITE_API_URL?: string
  readonly VITE_SHOW_ABOUT_PAGE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
