// Exécute le code de déchiffrage extrait du lecteur YouTube (fonctions « n » et « sig »).
// Isolé dans un Worker : pas d'accès au DOM, ni à IndexedDB de la page, ni aux commandes Tauri.
self.onmessage = (e: MessageEvent<{ id: number; code: string }>) => {
  const { id, code } = e.data;
  try {
    const result = new Function(code)();
    self.postMessage({ id, result: JSON.parse(JSON.stringify(result ?? null)) });
  } catch (err) {
    self.postMessage({ id, error: (err as Error)?.message ?? String(err) });
  }
};
