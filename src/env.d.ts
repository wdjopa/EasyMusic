/// <reference types="vite/client" />
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Adresse du serveur EnjoySing pour les apps (Tauri) ; vide sur le site. */
  readonly VITE_API_BASE?: string;
}
